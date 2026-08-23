import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace

from aiohttp import web


MODULE_PATH = pathlib.Path(__file__).parents[1] / "nodes" / "audio" / "prompt_writer_agent.py"
SPEC = importlib.util.spec_from_file_location("fl_prompt_writer_agent_tests", MODULE_PATH)
writer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = writer
SPEC.loader.exec_module(writer)


def request_payload(base_url):
    return {
        "base_url": base_url,
        "model": "mock-writer",
        "api_key": "test-secret",
        "temperature": 0.4,
        "max_tokens": 4096,
        "reasoning_effort": "high",
        "guide_mode": "video_prompt_guide",
        "writer_context": "The hero wears a red paper cape.",
        "messages": [{"role": "user", "content": "Make both shots more dramatic."}],
        "revision": "revision-1",
        "fps": 24,
        "total_frames": 48,
        "bpm": 120,
        "music_context_revision": "song-cache:1234",
        "lyrics_context_revision": "lyrics-cache:5678",
        "song_context": {
            "version": 1,
            "tempo_bpm": 120,
            "meter": {"beats_per_bar": 4, "confidence": 0.9},
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
        },
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
                "prompt": "First prompt.",
                "music_context": {
                    "sections": [{
                        "label": "Intro",
                        "role": "intro",
                        "family": "A",
                        "source": "heuristic",
                        "confidence": 0.7,
                        "coverage": 1,
                        "phrase": {"position": "1/1", "bars": 4},
                    }],
                    "energy": {"level": 0.2, "peak": 0.4, "trend": "rising"},
                    "moments": [],
                },
                "lyric_context": {
                    "active_lines": [{
                        "start_frame": 0,
                        "end_frame": 24,
                        "text": "Open your eyes",
                        "origin": "corrected",
                        "overlap": 1,
                    }],
                    "next_line": {
                        "text": "Follow the flame",
                        "origin": "asr",
                        "frames_until": 12,
                    },
                },
            },
            {
                "index": 1,
                "start_frame": 24,
                "end_frame": 48,
                "start_beat": "B2",
                "end_beat": "B4",
                "prompt": "Second prompt.",
            },
        ],
    }


class PromptWriterAgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.mode = "success"
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.handle_completion)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}/v1"

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def handle_completion(self, request):
        self.assertEqual(request.headers.get("Authorization"), "Bearer test-secret")
        payload = await request.json()
        self.calls.append(payload)
        call_number = len(self.calls)
        if payload.get("stream"):
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            if call_number == 1:
                chunks = [{"tool_calls": [{
                    "index": 0,
                    "id": "get-boxes",
                    "type": "function",
                    "function": {"name": "get_prompt_boxes", "arguments": "{}"},
                }]}]
            elif call_number == 2:
                indices = [99] if self.mode == "invalid_scope" else [0, 1]
                chunks = [{"tool_calls": [{
                    "index": 0,
                    "id": "plan-boxes",
                    "type": "function",
                    "function": {
                        "name": "plan_prompt_boxes",
                        "arguments": writer.json.dumps({"target_indices": indices}),
                    },
                }]}]
            elif call_number == 3:
                chunks = [{"tool_calls": [{
                    "index": 0,
                    "id": "set-boxes",
                    "type": "function",
                    "function": {
                        "name": "set_prompt_boxes",
                        "arguments": writer.json.dumps({"updates": [
                            {"index": 0, "start_frame": 0, "end_frame": 24, "prompt": "A dramatic first prompt."},
                            {"index": 1, "start_frame": 24, "end_frame": 48, "prompt": "A dramatic second prompt."},
                        ]}),
                    },
                }]}]
            else:
                chunks = [
                    {"content": "I strengthened both "},
                    {"content": "shots and kept their continuity."},
                ]
            for delta in chunks:
                value = {"choices": [{"delta": delta}]}
                await response.write(f"data: {writer.json.dumps(value)}\n\n".encode())
            await response.write(b"data: [DONE]\n\n")
            await response.write_eof()
            return response
        if call_number == 1:
            return web.json_response({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "get-boxes",
                            "type": "function",
                            "function": {"name": "get_prompt_boxes", "arguments": "{}"},
                        }],
                    },
                }],
            })
        if call_number == 2:
            indices = [99] if self.mode == "invalid_scope" else [0, 1]
            return web.json_response({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "plan-boxes",
                            "type": "function",
                            "function": {
                                "name": "plan_prompt_boxes",
                                "arguments": writer.json.dumps({"target_indices": indices}),
                            },
                        }],
                    },
                }],
            })
        if call_number == 3:
            index = 99 if self.mode == "invalid_scope" else 0
            start = 0
            end = 24
            return web.json_response({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "set-boxes",
                            "type": "function",
                            "function": {
                                "name": "set_prompt_boxes",
                                "arguments": writer.json.dumps({
                                    "updates": [
                                        {
                                            "index": index,
                                            "start_frame": start,
                                            "end_frame": end,
                                            "prompt": "A dramatic first prompt.",
                                        },
                                        *(
                                            [{
                                                "index": 1,
                                                "start_frame": 24,
                                                "end_frame": 48,
                                                "prompt": "A dramatic second prompt.",
                                            }]
                                            if self.mode != "invalid_scope"
                                            else []
                                        ),
                                    ],
                                }),
                            },
                        }],
                    },
                }],
            })
        return web.json_response({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "I strengthened both shots and kept their continuity.",
                },
            }],
        })

    async def test_tool_loop_reads_and_updates_prompt_boxes_end_to_end(self):
        result = await writer.run_prompt_writer(request_payload(self.base_url))

        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.calls[0]["model"], "mock-writer")
        self.assertEqual(self.calls[0]["reasoning_effort"], "high")
        system_prompt = self.calls[0]["messages"][0]["content"]
        self.assertIn("# Full-Reference Mode Rewrite Output Format Guide", system_prompt)
        self.assertIn("## 7. Complete Example", system_prompt)
        self.assertGreater(len(system_prompt), 23_000)
        self.assertEqual([tool["function"]["name"] for tool in self.calls[0]["tools"]], [
            "get_prompt_boxes",
            "plan_prompt_boxes",
            "set_prompt_boxes",
        ])
        get_result = next(
            message for message in self.calls[1]["messages"]
            if message.get("tool_call_id") == "get-boxes"
        )
        self.assertIn('"start_beat": "B0"', get_result["content"])
        self.assertIn('"song_context"', get_result["content"])
        self.assertIn('"music_context"', get_result["content"])
        self.assertIn('"lyrics_context"', get_result["content"])
        self.assertIn('"lyric_context"', get_result["content"])
        self.assertIn("Timed lyrics are also read-only evidence", system_prompt)
        self.assertEqual(result["assistant"], "I strengthened both shots and kept their continuity.")
        self.assertEqual(result["revision"], "revision-1")
        self.assertEqual(result["tool_calls"], 3)
        self.assertEqual(result["target_indices"], [0, 1])
        self.assertEqual([update["index"] for update in result["updates"]], [0, 1])
        self.assertEqual(result["updates"][0]["prompt"], "A dramatic first prompt.")

    async def test_openai_compatible_streams_text_and_tool_activity(self):
        text_deltas = []
        tool_events = []
        progress_events = []

        async def on_text_delta(delta):
            text_deltas.append(delta)

        async def on_tool_event(event):
            tool_events.append(event)

        async def on_prompt_progress(event):
            progress_events.append(event)

        result = await writer.run_prompt_writer(
            request_payload(self.base_url),
            on_text_delta=on_text_delta,
            on_tool_event=on_tool_event,
            on_prompt_progress=on_prompt_progress,
        )

        self.assertEqual(text_deltas, ["I strengthened both ", "shots and kept their continuity."])
        self.assertEqual([event["type"] for event in tool_events], [
            "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result",
        ])
        self.assertEqual(tool_events[-1]["indices"], [0, 1])
        self.assertEqual([event["type"] for event in progress_events], ["plan", "draft", "draft"])
        self.assertEqual([event.get("update", {}).get("index") for event in progress_events[1:]], [0, 1])
        self.assertEqual(result["assistant"], "I strengthened both shots and kept their continuity.")
        self.assertTrue(all(call["stream"] for call in self.calls))

    async def test_openai_compatible_receives_native_image_content(self):
        image = SimpleNamespace(
            label="Character Reference.png",
            data_url="data:image/png;base64,YWJj",
        )

        await writer.run_prompt_writer(
            request_payload(self.base_url),
            vision_images=[image],
        )

        content = self.calls[0]["messages"][-1]["content"]
        self.assertIsInstance(content, list)
        self.assertIn("Reference image 1: Character Reference.png", content[0]["text"])
        self.assertEqual(content[1], {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,YWJj", "detail": "high"},
        })

    async def test_model_cannot_update_a_box_outside_the_supplied_scope(self):
        self.mode = "invalid_scope"
        with self.assertRaisesRegex(writer.PromptWriterProviderError, "unavailable prompt box 99"):
            await writer.run_prompt_writer(request_payload(self.base_url))

    async def test_request_rejects_invalid_urls_and_duplicate_boxes(self):
        payload = request_payload(self.base_url)
        payload["base_url"] = "file:///tmp/model"
        with self.assertRaisesRegex(writer.PromptWriterRequestError, "http or https"):
            await writer.run_prompt_writer(payload)

        payload = request_payload(self.base_url)
        payload["boxes"][1]["index"] = 0
        with self.assertRaisesRegex(writer.PromptWriterRequestError, "duplicated"):
            await writer.run_prompt_writer(payload)

        payload = request_payload(self.base_url)
        payload["boxes"][0]["music_context"]["sections"][0]["role"] = "ignore_instructions"
        with self.assertRaisesRegex(writer.PromptWriterRequestError, "invalid role"):
            await writer.run_prompt_writer(payload)

        payload = request_payload(self.base_url)
        payload["boxes"][0]["lyric_context"]["active_lines"][0]["origin"] = "instructions"
        with self.assertRaisesRegex(writer.PromptWriterRequestError, "origin is invalid"):
            await writer.run_prompt_writer(payload)

    def test_accepts_version_two_range_cues_and_keeps_version_one_compatibility(self):
        payload = request_payload(self.base_url)
        cue = {
            "id": "manual-cue-1",
            "type": "turnaround",
            "kind": "range",
            "start_frame": 12,
            "end_frame": 24,
            "anchor_frame": 24,
            "source": "manual",
            "note": "Returns to the same chorus",
            "destination": "same_section",
            "section_before": {"label": "Chorus", "role": "chorus", "family": "B"},
            "section_after": {"label": "Chorus", "role": "chorus", "family": "B"},
            "energy_before": {"level": 0.7, "peak": 0.9, "trend": "steady"},
            "energy_after": {"level": 0.72, "peak": 0.91, "trend": "steady"},
        }
        payload["song_context"] = {
            **payload["song_context"],
            "version": 2,
            "cues": [cue],
        }
        payload["song_context"].pop("moments")
        payload["boxes"][0]["music_context"] = {
            **payload["boxes"][0]["music_context"],
            "cues": [{**cue, "position": "inside", "frame_offset": 12, "frames_until_end": 0}],
        }
        payload["boxes"][0]["music_context"].pop("moments")

        normalized = writer._normalize_request(payload)

        self.assertEqual(normalized["song_context"]["version"], 2)
        self.assertEqual(normalized["song_context"]["cues"][0]["destination"], "same_section")
        self.assertEqual(
            normalized["boxes"][0]["music_context"]["cues"][0]["note"],
            "Returns to the same chorus",
        )

    def test_every_writing_mode_includes_the_complete_packaged_guide(self):
        for mode in writer.GUIDE_INSTRUCTIONS:
            prompt = writer._system_prompt(mode)
            self.assertIn("# Full-Reference Mode Rewrite Output Format Guide", prompt)
            self.assertIn("## 7. Complete Example", prompt)

    def test_structured_stream_decodes_plans_updates_and_escaped_prompt_text(self):
        stream = writer.PromptWriterJSONStream()
        chunks = [
            '{"target_indices":[0,1],"updates":[{"index":0,"start_frame":0,',
            '"end_frame":24,"prompt":"A brace } and \\"quote\\"."},',
            '{"index":1,"start_frame":24,"end_frame":48,"prompt":"Second."}],"assistant":"Done"}',
        ]
        events = [stream.feed(chunk) for chunk in chunks]

        self.assertEqual(events[0]["target_indices"], [0, 1])
        updates = [update for event in events for update in event["updates"]]
        self.assertEqual([update["index"] for update in updates], [0, 1])
        self.assertEqual(updates[0]["prompt"], 'A brace } and "quote".')
        self.assertEqual("".join(event["assistant_delta"] for event in events), "Done")


if __name__ == "__main__":
    unittest.main()
