import asyncio
import importlib
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest

from PIL import Image


NODES_PATH = pathlib.Path(__file__).parents[1] / "nodes"
PACKAGE_NAME = "fl_prompt_writer_runtime_tests"
PACKAGE = types.ModuleType(PACKAGE_NAME)
PACKAGE.__path__ = [str(NODES_PATH)]
sys.modules.setdefault(PACKAGE_NAME, PACKAGE)
AUDIO_PACKAGE = types.ModuleType(f"{PACKAGE_NAME}.audio")
AUDIO_PACKAGE.__path__ = [str(NODES_PATH / "audio")]
sys.modules.setdefault(AUDIO_PACKAGE.__name__, AUDIO_PACKAGE)
TEST_DATA = tempfile.TemporaryDirectory()
os.environ["FL_PROMPT_WRITER_DATA_DIR"] = TEST_DATA.name

config = importlib.import_module(f"{PACKAGE_NAME}.audio.prompt_writer_config")
store_module = importlib.import_module(f"{PACKAGE_NAME}.audio.prompt_writer_store")
images_module = importlib.import_module(f"{PACKAGE_NAME}.audio.prompt_writer_images")
runtime_module = importlib.import_module(f"{PACKAGE_NAME}.audio.prompt_writer_runtime")


def document_payload():
    return {
        "scheduler_id": "scheduler-test",
        "message": "Make the opening more ominous.",
        "guide_mode": "video_prompt_guide",
        "writer_context": "Paper-cut stop motion.",
        "revision": "revision-1",
        "fps": 24,
        "total_frames": 48,
        "bpm": 120,
        "lyrics_context_revision": "lyrics-cache:5678",
        "lyrics_context": {
            "version": 1,
            "language": "en",
            "audio_source": "vocals",
            "lines": [{
                "start_frame": 0,
                "end_frame": 24,
                "text": "Open your eyes",
                "origin": "corrected",
            }],
        },
        "boxes": [
            {
                "index": 0,
                "start_frame": 0,
                "end_frame": 24,
                "start_beat": "B0",
                "end_beat": "B2",
                "prompt": "The magician enters.",
                "lyric_context": {
                    "active_lines": [{
                        "start_frame": 0,
                        "end_frame": 24,
                        "text": "Open your eyes",
                        "origin": "corrected",
                        "overlap": 1,
                    }],
                },
            },
            {
                "index": 1,
                "start_frame": 24,
                "end_frame": 48,
                "start_beat": "B2",
                "end_beat": "B4",
                "prompt": "He opens the book.",
            },
        ],
    }


class FakeCodexRuntime(runtime_module.PromptWriterRuntime):
    async def _run_codex(self, run, messages):
        self.seen_messages = messages
        self.seen_reasoning_effort = run.settings["reasoning_effort"]
        return (
            "I made the opening more ominous.",
            [{
                "index": 0,
                "start_frame": 0,
                "end_frame": 24,
                "prompt": "Paper hands assemble a black summoning circle around the magician.",
            }],
            {"providerThread": "fake-codex"},
        )


class PromptWriterStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = store_module.PromptWriterStore(pathlib.Path(self.directory.name) / "writer.db")

    def tearDown(self):
        self.directory.cleanup()

    def test_conversations_persist_revisions_archive_and_delete(self):
        conversation = self.store.create_conversation("scheduler-a", "codex_subscription", "gpt-test")
        first = self.store.append_message(conversation["id"], "user", "First", provider="codex_subscription")
        self.store.append_message(conversation["id"], "assistant", "Answer", parent_id=first["id"])
        answer = self.store.list_messages(conversation["id"])[-1]
        updated = self.store.update_message_metadata(answer["id"], {"promptApplication": {"status": "pending"}})
        self.assertEqual(updated["metadata"]["promptApplication"]["status"], "pending")
        revised = self.store.revise_user_message(
            conversation["id"],
            first["id"],
            "Revised",
            "codex_subscription",
            "gpt-test",
        )
        self.store.append_message(conversation["id"], "assistant", "New answer", parent_id=revised["id"])

        messages = self.store.list_messages(conversation["id"])
        self.assertEqual([item["content"] for item in messages], ["Revised", "New answer"])
        self.assertEqual(messages[0]["revision"]["count"], 2)
        previous = self.store.select_message_version(conversation["id"], revised["id"], "previous")
        self.assertEqual([item["content"] for item in previous], ["First", "Answer"])
        self.assertFalse(self.store.delete_conversation(conversation["id"]))
        self.store.archive_conversation(conversation["id"], True)
        self.assertTrue(self.store.delete_conversation(conversation["id"]))


class PromptWriterImageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_input_directory = images_module.folder_paths.get_input_directory
        images_module.folder_paths.get_input_directory = lambda: self.directory.name
        self.subfolder = images_module.writer_upload_subfolder("scheduler-test")
        path = pathlib.Path(self.directory.name) / self.subfolder
        path.mkdir(parents=True)
        self.image_path = path / "reference.png"
        Image.new("RGB", (2400, 1200), (180, 20, 40)).save(self.image_path)

    def tearDown(self):
        images_module.folder_paths.get_input_directory = self.original_input_directory
        self.directory.cleanup()

    def test_attachments_stay_in_the_scheduler_folder_and_become_bounded_vision_content(self):
        attachment = {
            "filename": "reference.png",
            "subfolder": self.subfolder,
            "type": "input",
            "originalName": "Character Reference.png",
            "mimeType": "image/png",
            "sizeBytes": 1,
            "width": 2400,
            "height": 1200,
        }
        normalized = images_module.normalize_prompt_writer_attachments(
            [attachment],
            "scheduler-test",
        )
        vision = images_module.load_prompt_writer_images(normalized)[0]

        self.assertEqual(normalized[0]["sizeBytes"], self.image_path.stat().st_size)
        self.assertEqual(vision.original_size, (2400, 1200))
        self.assertLessEqual(max(vision.preview_size), 2048)
        self.assertLessEqual(len(vision.data), images_module.MAX_VISION_BYTES * 2)
        self.assertTrue(vision.data_url.startswith("data:image/jpeg;base64,"))
        with self.assertRaisesRegex(ValueError, "outside this Beat Writer"):
            images_module.normalize_prompt_writer_attachments(
                [{**attachment, "subfolder": "fl-beat-writer/another-scheduler"}],
                "scheduler-test",
            )


class PromptWriterConfigTests(unittest.TestCase):
    def test_settings_accept_max_tokens_but_reject_credentials_and_unsupported_reasoning(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = config.WriterSettingsStore(pathlib.Path(directory) / "settings.json")
            self.assertEqual(settings.update({"max_tokens": 4096})["max_tokens"], 4096)
            with self.assertRaisesRegex(ValueError, "credential endpoint"):
                settings.update({"api_key": "secret"})
            with self.assertRaisesRegex(ValueError, "does not support ultra"):
                settings.update({"provider": "anthropic", "reasoning_effort": "ultra"})


class PromptWriterRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = store_module.PromptWriterStore(pathlib.Path(self.directory.name) / "writer.db")
        self.runtime = FakeCodexRuntime(self.store)
        self.original_load = runtime_module.writer_settings.load
        self.original_status = runtime_module.connection_status
        runtime_module.writer_settings.load = lambda: {
            "provider": "codex_subscription",
            "model": "gpt-test",
            "base_url": "",
            "reasoning_effort": "low",
            "temperature": 0.4,
            "max_tokens": 4096,
        }

        async def connected(_provider, refresh=False):
            del refresh
            return {"configured": True, "message": "Connected"}

        runtime_module.connection_status = connected

    async def asyncTearDown(self):
        runtime_module.writer_settings.load = self.original_load
        runtime_module.connection_status = self.original_status
        self.directory.cleanup()

    async def test_persistent_streaming_run_returns_revision_bound_prompt_updates(self):
        payload = document_payload()
        payload["reasoning_effort"] = "high"
        run = await self.runtime.start(payload)
        events = []
        async for raw in self.runtime.subscribe(run.id):
            events.append(json.loads(raw.removeprefix("data: ").strip()))

        self.assertEqual(events[0]["type"], "run_started")
        progress = [event for event in events if event["type"] == "prompt_progress"]
        self.assertEqual([event["version"] for event in progress], list(range(1, len(progress) + 1)))
        self.assertEqual(progress[0]["phase"], "planning")
        self.assertEqual(progress[1]["targetIndices"], [0])
        self.assertEqual(progress[2]["completedIndices"], [0])
        self.assertEqual(progress[-2]["phase"], "applying")
        self.assertEqual(progress[-1]["phase"], "complete")
        update_event = next(event for event in events if event["type"] == "prompt_updates")
        self.assertEqual(update_event["revision"], "revision-1")
        self.assertEqual(update_event["updates"][0]["index"], 0)
        self.assertEqual(events[-1]["type"], "run_finished")
        self.assertEqual(self.runtime.seen_reasoning_effort, "high")
        messages = self.store.list_messages(run.conversation_id)
        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])
        self.assertEqual(messages[-1]["metadata"]["providerThread"], "fake-codex")
        self.assertEqual(messages[-1]["metadata"]["promptApplication"]["status"], "pending")
        self.assertEqual(
            messages[-1]["metadata"]["promptApplication"]["lyricsContextRevision"],
            "lyrics-cache:5678",
        )

    async def test_image_only_request_persists_reference_metadata(self):
        input_directory = tempfile.TemporaryDirectory()
        original_input_directory = images_module.folder_paths.get_input_directory
        images_module.folder_paths.get_input_directory = lambda: input_directory.name
        try:
            subfolder = images_module.writer_upload_subfolder("scheduler-test")
            upload_directory = pathlib.Path(input_directory.name) / subfolder
            upload_directory.mkdir(parents=True)
            Image.new("RGB", (64, 32), (20, 180, 60)).save(upload_directory / "reference.png")
            payload = document_payload()
            payload["message"] = ""
            payload["attachments"] = [{
                "filename": "reference.png",
                "subfolder": subfolder,
                "type": "input",
                "originalName": "Green character.png",
                "mimeType": "image/png",
                "sizeBytes": 123,
                "width": 64,
                "height": 32,
            }]

            run = await self.runtime.start(payload)
            await run.task
            messages = self.store.list_messages(run.conversation_id)

            self.assertEqual(messages[0]["content"], "")
            self.assertEqual(
                messages[0]["metadata"]["attachments"][0]["originalName"],
                "Green character.png",
            )
            self.assertEqual(self.store.get_conversation(run.conversation_id)["title"], "Attached Green character.png")
        finally:
            images_module.folder_paths.get_input_directory = original_input_directory
            input_directory.cleanup()

    async def test_message_reference_images_persist_into_later_vision_context(self):
        input_directory = tempfile.TemporaryDirectory()
        original_input_directory = images_module.folder_paths.get_input_directory
        original_load_images = runtime_module.load_prompt_writer_images
        images_module.folder_paths.get_input_directory = lambda: input_directory.name
        try:
            subfolder = images_module.writer_upload_subfolder("scheduler-test")
            upload_directory = pathlib.Path(input_directory.name) / subfolder
            upload_directory.mkdir(parents=True)
            Image.new("RGB", (32, 64), (40, 80, 200)).save(upload_directory / "message.png")

            def attachment(filename, original_name):
                return {
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": "input",
                    "originalName": original_name,
                    "mimeType": "image/png",
                    "sizeBytes": 1,
                    "width": 64,
                    "height": 32,
                }

            payload = document_payload()
            payload["attachments"] = [attachment("message.png", "Shot sketch.png")]
            run = await self.runtime.start(payload)
            await run.task

            messages = self.store.list_messages(run.conversation_id)
            self.assertEqual(
                [item["originalName"] for item in messages[0]["metadata"]["attachments"]],
                ["Shot sketch.png"],
            )
            messages.append({"role": "user", "content": "Use the same visual reference in the next shot."})
            runtime_module.load_prompt_writer_images = lambda attachments: attachments
            vision = await self.runtime._vision_context(run, messages)
            self.assertEqual(
                [item["originalName"] for item in vision],
                ["Shot sketch.png"],
            )
        finally:
            runtime_module.load_prompt_writer_images = original_load_images
            images_module.folder_paths.get_input_directory = original_input_directory
            input_directory.cleanup()

    async def test_disconnected_subscriber_does_not_cancel_the_background_run(self):
        release = asyncio.Event()

        async def delayed(_run, _messages):
            await self.runtime._plan_progress(_run, [0, 1])
            await self.runtime._draft_progress(_run, {
                "index": 0,
                "start_frame": 0,
                "end_frame": 24,
                "prompt": "The paper ritual continues after the tab closes.",
            })
            await release.wait()
            return (
                "Finished after disconnect.",
                [
                    {
                        "index": 0,
                        "start_frame": 0,
                        "end_frame": 24,
                        "prompt": "The paper ritual continues after the tab closes.",
                    },
                    {
                        "index": 1,
                        "start_frame": 24,
                        "end_frame": 48,
                        "prompt": "The book opens after the tab closes.",
                    },
                ],
                {"_target_indices": [0, 1]},
            )

        self.runtime._run_codex = delayed
        run = await self.runtime.start(document_payload())
        subscription = self.runtime.subscribe(run.id)
        first = json.loads((await anext(subscription)).removeprefix("data: ").strip())
        self.assertEqual(first["type"], "run_started")
        await subscription.aclose()

        active = self.runtime.active("scheduler-test")
        for _attempt in range(20):
            if active["progress"]["targetIndices"]:
                break
            await asyncio.sleep(0)
            active = self.runtime.active("scheduler-test")
        self.assertEqual(active["runId"], run.id)
        self.assertEqual(active["document"]["revision"], "revision-1")
        self.assertEqual(active["document"]["lyrics_context_revision"], "lyrics-cache:5678")
        self.assertEqual(active["progress"]["targetIndices"], [0, 1])
        self.assertEqual(active["progress"]["completedIndices"], [0])
        self.assertEqual(active["progress"]["activeIndex"], 1)
        release.set()
        await run.task

        messages = self.store.list_messages(run.conversation_id)
        self.assertEqual(messages[-1]["content"], "Finished after disconnect.")
        self.assertEqual(messages[-1]["metadata"]["promptApplication"]["status"], "pending")

    async def test_stopping_after_partial_progress_applies_no_prompt_updates(self):
        release = asyncio.Event()

        async def delayed(run, _messages):
            await self.runtime._plan_progress(run, [0, 1])
            await self.runtime._draft_progress(run, {
                "index": 0,
                "start_frame": 0,
                "end_frame": 24,
                "prompt": "A completed draft that must remain staged.",
            })
            await release.wait()

        self.runtime._run_codex = delayed
        run = await self.runtime.start(document_payload())
        for _attempt in range(20):
            if run.progress_completed:
                break
            await asyncio.sleep(0)
        self.assertEqual(run.progress_completed, [0])
        self.assertTrue(await self.runtime.cancel(run.id))
        events = []
        async for raw in self.runtime.subscribe(run.id):
            events.append(json.loads(raw.removeprefix("data: ").strip()))

        self.assertNotIn("prompt_updates", {event["type"] for event in events})
        self.assertEqual(events[-2]["type"], "prompt_progress")
        self.assertEqual(events[-2]["phase"], "stopped")
        self.assertEqual(events[-1]["type"], "run_stopped")
        self.assertEqual([box["prompt"] for box in run.document["boxes"]], [
            "The magician enters.",
            "He opens the book.",
        ])

    def test_http_disconnect_path_does_not_cancel_or_discard_the_run(self):
        routes = pathlib.Path(__file__).parents[1] / "routes" / "audio_timeline.py"
        source = routes.read_text(encoding="utf-8")
        start = source.index("async def start_prompt_writer_run")
        end = source.index("async def active_prompt_writer_run", start)
        handler = source[start:end]
        self.assertIn("ConnectionError", handler)
        self.assertNotIn("prompt_writer_runtime.cancel", handler)
        self.assertNotIn("prompt_writer_runtime.discard", handler)

    async def test_applied_acknowledgment_prevents_deferred_reapplication(self):
        run = await self.runtime.start(document_payload())
        self.assertTrue(await self.runtime.acknowledge_updates(run.id))
        async for _raw in self.runtime.subscribe(run.id):
            pass
        assistant = self.store.list_messages(run.conversation_id)[-1]
        self.assertEqual(assistant["metadata"]["promptApplication"]["status"], "applied")

    async def test_structured_providers_receive_the_complete_guide_and_writer_context(self):
        for mode in runtime_module.GUIDE_INSTRUCTIONS:
            system_prompt = runtime_module._structured_system_prompt(mode)
            self.assertIn("# Full-Reference Mode Rewrite Output Format Guide", system_prompt)
            self.assertIn("## 7. Complete Example", system_prompt)
            self.assertGreater(len(system_prompt), 23_000)
        payload = document_payload()
        payload["song_context"] = {
            "version": 1,
            "tempo_bpm": 120,
            "sections": [{
                "label": "Intro",
                "role": "intro",
                "family": "A",
                "source": "heuristic",
                "confidence": 0.7,
                "start_frame": 0,
                "end_frame": 24,
            }],
            "moments": [],
        }
        prompt = runtime_module._structured_prompt(
            runtime_module._normalize_document(payload),
            [{"role": "user", "content": "Continue the scene."}],
        )
        self.assertIn("Paper-cut stop motion.", prompt)
        self.assertIn('"role": "intro"', prompt)
        self.assertIn('"text": "Open your eyes"', prompt)
        self.assertIn("Treat timed lyrics as read-only evidence", system_prompt)

    def test_provider_image_payloads_are_native_multimodal_inputs(self):
        image = images_module.PromptWriterImage(
            data="YWJj",
            media_type="image/png",
            label="Character.png",
            original_size=(10, 20),
            preview_size=(10, 20),
        )
        anthropic = runtime_module._anthropic_content("Write the prompts.", [image])
        self.assertEqual(anthropic[0], {"type": "text", "text": "Write the prompts."})
        self.assertEqual(anthropic[1]["source"]["media_type"], "image/png")
        self.assertEqual(anthropic[1]["source"]["data"], "YWJj")

        codex = runtime_module._codex_input("Write the prompts.", [image])
        self.assertEqual(codex[0].text, "Write the prompts.")
        self.assertEqual(codex[1].url, "data:image/png;base64,YWJj")

    async def test_structured_stream_exposes_only_incremental_assistant_text(self):
        stream = runtime_module._StructuredAssistantStream()
        chunks = [
            '{"assistant":"The paper hand ',
            'folds a \\"black\\" sigil.\\nThen ',
            'the floor opens","updates":[]}',
        ]
        deltas = [stream.feed(chunk) for chunk in chunks]
        self.assertEqual("".join(deltas), 'The paper hand folds a "black" sigil.\nThen the floor opens')
        self.assertNotIn("updates", "".join(deltas))

    async def test_progress_rejects_out_of_order_drafts_without_mutating_the_document(self):
        run = runtime_module.WriterRun(
            id="progress-test",
            conversation_id="conversation-test",
            user_message_id="user-test",
            document=runtime_module._normalize_document(document_payload()),
            settings={},
        )
        await self.runtime._plan_progress(run, [0, 1])
        original = [box["prompt"] for box in run.document["boxes"]]

        with self.assertRaisesRegex(runtime_module.PromptWriterProviderError, "edit plan order"):
            await self.runtime._draft_progress(run, {
                "index": 1,
                "start_frame": 24,
                "end_frame": 48,
                "prompt": "Out of order.",
            })

        self.assertEqual([box["prompt"] for box in run.document["boxes"]], original)
        self.assertEqual(run.progress_phase, "error")
        self.assertEqual(run.progress_failed, 1)

    async def test_claude_sdk_never_receives_a_windows_batch_launcher(self):
        self.assertIsNone(runtime_module._native_claude_cli(r"C:\Users\test\npm\claude.cmd"))
        self.assertIsNone(runtime_module._native_claude_cli(r"C:\tools\claude.bat"))
        self.assertEqual(
            runtime_module._native_claude_cli(r"C:\tools\claude.exe"),
            r"C:\tools\claude.exe",
        )

    async def test_tool_activity_is_persisted_with_the_assistant_message(self):
        run = await self.runtime.start(document_payload())
        async for _raw in self.runtime.subscribe(run.id):
            pass
        assistant = self.store.list_messages(run.conversation_id)[-1]
        self.assertEqual(assistant["metadata"]["toolSteps"][0]["name"], "set_prompt_boxes")
        self.assertEqual(assistant["metadata"]["toolSteps"][0]["status"], "complete")

    async def test_stale_or_out_of_scope_provider_update_fails_without_persisting_assistant(self):
        async def invalid(_run, _messages):
            return "Changed it.", [{
                "index": 99,
                "start_frame": 0,
                "end_frame": 24,
                "prompt": "Invalid",
            }], {}

        self.runtime._run_codex = invalid
        run = await self.runtime.start(document_payload())
        events = []
        async for raw in self.runtime.subscribe(run.id):
            events.append(json.loads(raw.removeprefix("data: ").strip()))
        self.assertEqual(events[-1]["type"], "run_error")
        self.assertNotIn("prompt_updates", {event["type"] for event in events})
        messages = self.store.list_messages(run.conversation_id)
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[-1]["status"], "error")
        self.assertIn("unavailable prompt box 99", messages[-1]["content"])


if __name__ == "__main__":
    unittest.main()
