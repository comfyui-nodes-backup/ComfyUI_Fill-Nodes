import asyncio
import threading
import uuid

from aiohttp import web
from server import PromptServer

from ..nodes.audio.audio_separation import (
    SeparationCancelled,
    separate_audio_file,
    separation_manifest,
)
from ..nodes.audio.audio_transcription import (
    AudioTranscriptionError,
    TranscriptionCancelled,
    cached_transcript,
    load_cached_transcript,
    transcribe_audio_file,
    transcription_model_status,
)
from ..nodes.audio.audio_files import audio_library_entries
from ..nodes.audio.audio_timeline import analyze_audio_file
from ..nodes.audio.audio_song_map import analyze_song_map_file
from ..nodes.audio.beat_this_detector import BeatThisError, model_status
from ..nodes.audio.prompt_writer_agent import (
    PromptWriterProviderError,
    PromptWriterRequestError,
    run_prompt_writer,
)
from ..nodes.audio.prompt_writer_config import (
    PROVIDER_PRESETS,
    claude_subscription,
    codex_subscription,
    connection_status,
    credential_store,
    discover_models,
    writer_settings,
)
from ..nodes.audio.prompt_writer_runtime import prompt_writer_runtime
from ..nodes.audio.prompt_writer_store import prompt_writer_store


_separation_jobs = {}
_job_lock = threading.Lock()
_active_separation_job = None
_transcription_jobs = {}
_active_transcription_job = None


def _public_job(job):
    return {
        key: value
        for key, value in job.items()
        if key not in {"cancel_event", "task"}
    }


def _update_separation_job(job_id, progress, message):
    with _job_lock:
        job = _separation_jobs.get(job_id)
        if job is None:
            return
        job["progress"] = float(progress)
        job["message"] = message


async def _run_separation_job(job_id, filename):
    global _active_separation_job
    job = _separation_jobs[job_id]
    with _job_lock:
        job["status"] = "running"
        job["message"] = "Loading stem model"
    try:
        manifest = await asyncio.to_thread(
            separate_audio_file,
            filename,
            lambda progress, message: _update_separation_job(job_id, progress, message),
            job["cancel_event"],
        )
        with _job_lock:
            job["status"] = "completed"
            job["progress"] = 1.0
            job["message"] = "Stem separation complete"
            job["manifest"] = manifest
    except SeparationCancelled as error:
        with _job_lock:
            job["status"] = "cancelled"
            job["message"] = str(error)
    except Exception as error:
        with _job_lock:
            job["status"] = "error"
            job["message"] = str(error)
    finally:
        with _job_lock:
            if _active_separation_job == job_id:
                _active_separation_job = None


def _update_transcription_job(job_id, progress, message):
    with _job_lock:
        job = _transcription_jobs.get(job_id)
        if job is None:
            return
        job["progress"] = float(progress)
        job["message"] = message


async def _run_transcription_job(job_id):
    global _active_transcription_job
    job = _transcription_jobs[job_id]
    with _job_lock:
        job["status"] = "running"
        job["message"] = "Loading lyrics transcription model"
    try:
        transcript = await asyncio.to_thread(
            transcribe_audio_file,
            job["audio_file"],
            job["source"],
            job["model"],
            job["language"],
            job["allow_download"],
            lambda progress, message: _update_transcription_job(job_id, progress, message),
            job["cancel_event"],
        )
        with _job_lock:
            job["status"] = "completed"
            job["progress"] = 1.0
            job["message"] = "Lyrics transcription complete"
            job["transcript"] = transcript
    except TranscriptionCancelled as error:
        with _job_lock:
            job["status"] = "cancelled"
            job["message"] = str(error)
    except Exception as error:
        with _job_lock:
            job["status"] = "error"
            job["message"] = str(error)
    finally:
        with _job_lock:
            if _active_transcription_job == job_id:
                _active_transcription_job = None


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/analyze")
async def analyze_audio_timeline(request):
    try:
        values = await request.json()
        analysis, _ = await asyncio.to_thread(
            analyze_audio_file,
            values.get("audio_file"),
            float(values.get("fps", 24.0)),
            int(values.get("trim_start_frame", 0)),
            int(values.get("length_frames", 0)),
            bool(values.get("half_time", False)),
            int(values.get("beat_offset_ms", 0)),
            values.get("analysis_source", "mix"),
        )
        song_map = await asyncio.to_thread(
            analyze_song_map_file,
            values.get("audio_file"),
            analysis["source_analysis"],
        )
        analysis["song_map"] = song_map
        analysis["source_analysis"] = {
            **analysis["source_analysis"],
            "song_map": song_map,
        }
        return web.json_response(analysis)
    except (BeatThisError, TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/beat-model/status")
async def beat_model_status(_request):
    return web.json_response(model_status())


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/files")
async def audio_timeline_files(_request):
    files = await asyncio.to_thread(audio_library_entries)
    return web.json_response({"files": files})


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/separate")
async def start_audio_separation(request):
    global _active_separation_job
    try:
        values = await request.json()
        filename = values.get("audio_file")
        cached = await asyncio.to_thread(separation_manifest, filename)
        if cached is not None:
            return web.json_response({
                "status": "completed",
                "progress": 1.0,
                "message": "Using cached stems",
                "manifest": cached,
            })

        with _job_lock:
            if _active_transcription_job is not None:
                return web.json_response(
                    {"error": "Lyrics transcription is currently using the audio model device."},
                    status=409,
                )
            if _active_separation_job is not None:
                active = _separation_jobs[_active_separation_job]
                return web.json_response(
                    {
                        "error": "Another stem separation is already running.",
                        "job": _public_job(active),
                    },
                    status=409,
                )
            completed = [
                job_id
                for job_id, job in _separation_jobs.items()
                if job["status"] in {"completed", "cancelled", "error"}
            ]
            for old_job_id in completed[:-20]:
                del _separation_jobs[old_job_id]
            job_id = str(uuid.uuid4())
            job = {
                "job_id": job_id,
                "audio_file": filename,
                "status": "queued",
                "progress": 0.0,
                "message": "Stem separation queued",
                "cancel_event": threading.Event(),
            }
            _separation_jobs[job_id] = job
            _active_separation_job = job_id
        job["task"] = asyncio.create_task(_run_separation_job(job_id, filename))
        return web.json_response(_public_job(job), status=202)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/separate/{job_id}")
async def get_audio_separation(request):
    job_id = request.match_info["job_id"]
    with _job_lock:
        job = _separation_jobs.get(job_id)
        if job is None:
            return web.json_response({"error": "Stem separation job was not found."}, status=404)
        return web.json_response(_public_job(job))


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/separate/{job_id}/cancel")
async def cancel_audio_separation(request):
    job_id = request.match_info["job_id"]
    with _job_lock:
        job = _separation_jobs.get(job_id)
        if job is None:
            return web.json_response({"error": "Stem separation job was not found."}, status=404)
        if job["status"] in {"completed", "cancelled", "error"}:
            return web.json_response(_public_job(job))
        job["cancel_event"].set()
        job["message"] = "Cancelling after the current chunk"
        return web.json_response(_public_job(job))


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/transcription-model/status")
async def audio_transcription_model_status(request):
    try:
        return web.json_response(transcription_model_status(request.query.get("model", "large-v3-turbo")))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/transcripts/{cache_key}")
async def get_cached_audio_transcript(request):
    try:
        transcript = await asyncio.to_thread(load_cached_transcript, request.match_info["cache_key"])
        if transcript is None:
            return web.json_response({"error": "Lyrics transcript was not found."}, status=404)
        return web.json_response({"transcript": transcript})
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/transcribe")
async def start_audio_transcription(request):
    global _active_transcription_job
    try:
        values = await request.json()
        filename = values.get("audio_file")
        source = values.get("source", "auto")
        model = values.get("model", "large-v3-turbo")
        language = values.get("language", "auto")
        allow_download = values.get("allow_download") is True
        cached = await asyncio.to_thread(cached_transcript, filename, source, model, language)
        if cached is not None:
            return web.json_response({
                "status": "completed",
                "progress": 1.0,
                "message": "Using cached lyrics",
                "transcript": cached,
            })

        with _job_lock:
            if _active_separation_job is not None:
                return web.json_response(
                    {"error": "Stem separation is currently using the audio model device."},
                    status=409,
                )
            if _active_transcription_job is not None:
                active = _transcription_jobs[_active_transcription_job]
                return web.json_response(
                    {
                        "error": "Another lyrics transcription is already running.",
                        "job": _public_job(active),
                    },
                    status=409,
                )
            completed = [
                job_id
                for job_id, job in _transcription_jobs.items()
                if job["status"] in {"completed", "cancelled", "error"}
            ]
            for old_job_id in completed[:-20]:
                del _transcription_jobs[old_job_id]
            job_id = str(uuid.uuid4())
            job = {
                "job_id": job_id,
                "audio_file": filename,
                "source": source,
                "model": model,
                "language": language,
                "allow_download": allow_download,
                "status": "queued",
                "progress": 0.0,
                "message": "Lyrics transcription queued",
                "cancel_event": threading.Event(),
            }
            _transcription_jobs[job_id] = job
            _active_transcription_job = job_id
        job["task"] = asyncio.create_task(_run_transcription_job(job_id))
        return web.json_response(_public_job(job), status=202)
    except (AudioTranscriptionError, TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/transcribe/{job_id}")
async def get_audio_transcription(request):
    job_id = request.match_info["job_id"]
    with _job_lock:
        job = _transcription_jobs.get(job_id)
        if job is None:
            return web.json_response({"error": "Lyrics transcription job was not found."}, status=404)
        return web.json_response(_public_job(job))


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/transcribe/{job_id}/cancel")
async def cancel_audio_transcription(request):
    job_id = request.match_info["job_id"]
    with _job_lock:
        job = _transcription_jobs.get(job_id)
        if job is None:
            return web.json_response({"error": "Lyrics transcription job was not found."}, status=404)
        if job["status"] in {"completed", "cancelled", "error"}:
            return web.json_response(_public_job(job))
        job["cancel_event"].set()
        job["message"] = "Cancelling after the current chunk"
        return web.json_response(_public_job(job))


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/chat")
async def write_audio_timeline_prompts(request):
    try:
        return web.json_response(await run_prompt_writer(await request.json()))
    except PromptWriterRequestError as error:
        return web.json_response({"error": str(error)}, status=400)
    except PromptWriterProviderError as error:
        return web.json_response({"error": str(error)}, status=502)


def _writer_error(error, status=400):
    return web.json_response({"error": str(error)}, status=status)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/status")
async def prompt_writer_status(_request):
    settings = writer_settings.load()
    preset = PROVIDER_PRESETS[settings["provider"]]
    connection = await connection_status(settings["provider"])
    return web.json_response({
        "configured": bool(settings["model"]) and (
            connection["configured"] if preset["requires_key"] or preset["type"] in {"codex_cli", "claude_cli"} else True
        ),
        "provider": settings["provider"],
        "model": settings["model"],
        "connection": connection,
    })


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/settings")
async def get_prompt_writer_settings(_request):
    value = writer_settings.public()
    value["credential"] = await connection_status(value["provider"])
    return web.json_response(value)


@PromptServer.instance.routes.put("/fl/audio-prompt-timeline/writer/settings")
async def update_prompt_writer_settings(request):
    try:
        value = writer_settings.update(await request.json())
        public = writer_settings.public()
        public["credential"] = await connection_status(value["provider"], refresh=True)
        return web.json_response(public)
    except (TypeError, ValueError) as error:
        return _writer_error(error)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/models")
async def get_prompt_writer_models(request):
    try:
        models = await discover_models(
            writer_settings.load(),
            refresh=request.query.get("refresh") == "1",
        )
        return web.json_response({"models": models})
    except (TypeError, ValueError) as error:
        return _writer_error(error, 502)


@PromptServer.instance.routes.put("/fl/audio-prompt-timeline/writer/credentials/{provider}")
async def set_prompt_writer_credential(request):
    try:
        provider = request.match_info["provider"]
        body = await request.json()
        return web.json_response(credential_store.set(provider, body.get("credential")))
    except (TypeError, ValueError) as error:
        return _writer_error(error)


@PromptServer.instance.routes.delete("/fl/audio-prompt-timeline/writer/credentials/{provider}")
async def clear_prompt_writer_credential(request):
    try:
        credential_store.clear(request.match_info["provider"])
        return web.json_response({"cleared": True})
    except ValueError as error:
        return _writer_error(error)


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/subscriptions/{provider}/login")
async def prompt_writer_subscription_login(request):
    try:
        provider = request.match_info["provider"]
        service = codex_subscription if provider == "codex" else claude_subscription if provider == "claude" else None
        if service is None:
            raise ValueError("Unknown subscription provider.")
        return web.json_response(service.launch_login())
    except (RuntimeError, ValueError) as error:
        return _writer_error(error)


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/subscriptions/{provider}/refresh")
async def prompt_writer_subscription_refresh(request):
    provider = request.match_info["provider"]
    service = codex_subscription if provider == "codex" else claude_subscription if provider == "claude" else None
    if service is None:
        return _writer_error(ValueError("Unknown subscription provider."))
    return web.json_response(await service.status(refresh=True))


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/conversations")
async def list_prompt_writer_conversations(request):
    scheduler_id = request.query.get("scheduler_id", "").strip()
    if not scheduler_id:
        return _writer_error(ValueError("scheduler_id is required."))
    return web.json_response({
        "conversations": prompt_writer_store.list_conversations(
            scheduler_id,
            archived=request.query.get("archived") == "1",
        )
    })


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/conversations")
async def create_prompt_writer_conversation(request):
    try:
        body = await request.json()
        scheduler_id = str(body.get("scheduler_id") or "").strip()
        if not scheduler_id:
            raise ValueError("scheduler_id is required.")
        settings = writer_settings.load()
        conversation = prompt_writer_store.create_conversation(
            scheduler_id,
            settings["provider"],
            settings["model"],
        )
        return web.json_response({"conversation": conversation}, status=201)
    except (TypeError, ValueError) as error:
        return _writer_error(error)


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/conversations/{conversation_id}")
async def get_prompt_writer_conversation(request):
    conversation_id = request.match_info["conversation_id"]
    conversation = prompt_writer_store.get_conversation(conversation_id)
    if not conversation:
        return _writer_error(ValueError("Conversation was not found."), 404)
    return web.json_response({
        "conversation": conversation,
        "messages": prompt_writer_store.list_messages(conversation_id),
    })


@PromptServer.instance.routes.patch("/fl/audio-prompt-timeline/writer/conversations/{conversation_id}")
async def update_prompt_writer_conversation(request):
    try:
        conversation_id = request.match_info["conversation_id"]
        body = await request.json()
        if "archived" in body:
            conversation = prompt_writer_store.archive_conversation(conversation_id, bool(body["archived"]))
        elif "title" in body:
            title = str(body["title"] or "").strip()[:100]
            if not title:
                raise ValueError("Conversation title cannot be empty.")
            conversation = prompt_writer_store.update_conversation(conversation_id, title=title)
        else:
            raise ValueError("No supported conversation change was supplied.")
        if not conversation:
            return _writer_error(ValueError("Conversation was not found."), 404)
        return web.json_response({"conversation": conversation})
    except (TypeError, ValueError) as error:
        return _writer_error(error)


@PromptServer.instance.routes.delete("/fl/audio-prompt-timeline/writer/conversations/{conversation_id}")
async def delete_prompt_writer_conversation(request):
    if not prompt_writer_store.delete_conversation(request.match_info["conversation_id"]):
        return _writer_error(ValueError("Archive the conversation before deleting it."), 409)
    return web.json_response({"deleted": True})


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/conversations/{conversation_id}/messages/{message_id}/version")
async def select_prompt_writer_message_version(request):
    try:
        body = await request.json()
        direction = str(body.get("direction") or "")
        if direction not in {"previous", "next"}:
            raise ValueError("Message version direction is invalid.")
        messages = prompt_writer_store.select_message_version(
            request.match_info["conversation_id"],
            request.match_info["message_id"],
            direction,
        )
        return web.json_response({"messages": messages})
    except ValueError as error:
        return _writer_error(error)


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/runs")
async def start_prompt_writer_run(request):
    try:
        run = await prompt_writer_runtime.start(await request.json())
    except (PromptWriterRequestError, TypeError, ValueError) as error:
        return _writer_error(error)
    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Prompt-Writer-Run-Id": run.id,
            "X-Prompt-Writer-Conversation-Id": run.conversation_id,
        },
    )
    await response.prepare(request)
    try:
        async for event in prompt_writer_runtime.subscribe(run.id):
            await response.write(event.encode("utf-8"))
    except (ConnectionError, asyncio.CancelledError):
        pass
    return response


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/runs/active")
async def active_prompt_writer_run(request):
    scheduler_id = str(request.query.get("scheduler_id") or "").strip()
    if not scheduler_id or len(scheduler_id) > 128:
        return _writer_error(ValueError("Scheduler ID is required."))
    return web.json_response({"run": prompt_writer_runtime.active(scheduler_id)})


@PromptServer.instance.routes.get("/fl/audio-prompt-timeline/writer/runs/{run_id}/events")
async def resume_prompt_writer_run(request):
    run_id = request.match_info["run_id"]
    if run_id not in prompt_writer_runtime.runs:
        return _writer_error(ValueError("Writer run was not found."), 404)
    response = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Prompt-Writer-Run-Id": run_id,
    })
    await response.prepare(request)
    try:
        async for event in prompt_writer_runtime.subscribe(run_id):
            await response.write(event.encode("utf-8"))
    except (ConnectionError, asyncio.CancelledError):
        pass
    return response


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/runs/{run_id}/applied")
async def acknowledge_prompt_writer_run(request):
    return web.json_response({
        "acknowledged": await prompt_writer_runtime.acknowledge_updates(request.match_info["run_id"])
    })


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/runs/{run_id}/cancel")
async def cancel_prompt_writer_run(request):
    return web.json_response({
        "cancelled": await prompt_writer_runtime.cancel(request.match_info["run_id"])
    })


@PromptServer.instance.routes.post("/fl/audio-prompt-timeline/writer/conversations/{conversation_id}/messages/{message_id}/applied")
async def acknowledge_prompt_writer_message(request):
    message = prompt_writer_store.get_message(request.match_info["message_id"])
    if not message or message["conversationId"] != request.match_info["conversation_id"] or message["role"] != "assistant":
        return _writer_error(ValueError("Writer response was not found."), 404)
    application = dict(message["metadata"].get("promptApplication") or {})
    application["status"] = "applied"
    updated = prompt_writer_store.update_message_metadata(message["id"], {
        "promptApplication": application,
    })
    return web.json_response({"message": updated})
