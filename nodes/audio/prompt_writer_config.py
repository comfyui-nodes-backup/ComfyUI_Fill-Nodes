import asyncio
import json
import os
import platform
import shlex
import shutil
import subprocess
import time
from collections import Counter
from copy import deepcopy
from pathlib import Path

import aiohttp
import folder_paths


DATA_DIR = Path(
    os.getenv(
        "FL_PROMPT_WRITER_DATA_DIR",
        Path(folder_paths.get_user_directory()) / "fl_audio_prompt_writer",
    )
)
SETTINGS_PATH = DATA_DIR / "settings.json"
KEYRING_SERVICE = "comfyui-fill-nodes-beat-writer"
REASONING_EFFORTS = {"default", "low", "medium", "high", "xhigh", "max", "ultra"}

PROVIDER_PRESETS = {
    "lmstudio": {
        "label": "LM Studio",
        "type": "openai_compatible",
        "base_url": "http://127.0.0.1:1234/v1",
        "requires_key": False,
        "default_model": "",
        "reasoning_efforts": ["low", "medium", "high"],
    },
    "ollama": {
        "label": "Ollama",
        "type": "openai_compatible",
        "base_url": "http://127.0.0.1:11434/v1",
        "requires_key": False,
        "default_model": "",
        "reasoning_efforts": ["low", "medium", "high"],
    },
    "openai": {
        "label": "OpenAI",
        "type": "openai_compatible",
        "base_url": "https://api.openai.com/v1",
        "requires_key": True,
        "default_model": "gpt-5.6-luna",
        "reasoning_efforts": ["low", "medium", "high"],
    },
    "openrouter": {
        "label": "OpenRouter",
        "type": "openai_compatible",
        "base_url": "https://openrouter.ai/api/v1",
        "requires_key": True,
        "default_model": "openai/gpt-5.6-luna",
        "reasoning_efforts": ["low", "medium", "high"],
    },
    "anthropic": {
        "label": "Anthropic",
        "type": "anthropic",
        "base_url": "https://api.anthropic.com",
        "requires_key": True,
        "default_model": "claude-sonnet-4-5",
        "reasoning_efforts": [],
    },
    "claude_subscription": {
        "label": "Claude subscription",
        "type": "claude_cli",
        "base_url": "",
        "requires_key": False,
        "default_model": "sonnet",
        "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
        "models": [
            {"id": "default", "label": "Account default"},
            {"id": "sonnet", "label": "Claude Sonnet"},
            {"id": "opus", "label": "Claude Opus"},
            {"id": "haiku", "label": "Claude Haiku"},
        ],
    },
    "codex_subscription": {
        "label": "Codex subscription",
        "type": "codex_cli",
        "base_url": "",
        "requires_key": False,
        "default_model": "gpt-5.6-sol",
        "reasoning_efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "models": [
            {"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol"},
            {"id": "gpt-5.6-terra", "label": "GPT-5.6-Terra"},
            {"id": "gpt-5.6-luna", "label": "GPT-5.6-Luna"},
            {"id": "gpt-5.5", "label": "GPT-5.5"},
            {"id": "gpt-5.4", "label": "GPT-5.4"},
        ],
    },
    "custom": {
        "label": "Custom endpoint",
        "type": "openai_compatible",
        "base_url": "",
        "requires_key": False,
        "default_model": "",
        "reasoning_efforts": ["low", "medium", "high"],
    },
}

ENV_KEYS = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "custom": "FL_PROMPT_WRITER_API_KEY",
}


def default_settings():
    return {
        "provider": "lmstudio",
        "model": "",
        "base_url": PROVIDER_PRESETS["lmstudio"]["base_url"],
        "reasoning_effort": "default",
        "temperature": 0.4,
        "max_tokens": 16_384,
    }


class WriterSettingsStore:
    ALLOWED_FIELDS = {
        "provider",
        "model",
        "base_url",
        "reasoning_effort",
        "temperature",
        "max_tokens",
    }

    def __init__(self, path=SETTINGS_PATH):
        self.path = Path(path)

    def load(self):
        value = default_settings()
        if self.path.exists():
            try:
                saved = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    value.update({key: saved[key] for key in self.ALLOWED_FIELDS if key in saved})
            except (OSError, json.JSONDecodeError):
                pass
        return self._normalize(value)

    def update(self, changes):
        if not isinstance(changes, dict):
            raise ValueError("Writer settings must be an object.")
        unknown = set(changes) - self.ALLOWED_FIELDS
        if unknown:
            if any("key" in str(key).lower() or "credential" in str(key).lower() for key in unknown):
                raise ValueError("Credentials must use the credential endpoint.")
            raise ValueError(f"Unsupported settings: {', '.join(sorted(unknown))}")
        value = self.load()
        value.update(changes)
        value = self._normalize(value)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(value, indent=2), encoding="utf-8")
        return value

    def public(self):
        value = self.load()
        value["presets"] = deepcopy(PROVIDER_PRESETS)
        return value

    @staticmethod
    def _normalize(value):
        provider = str(value.get("provider") or "lmstudio").strip().lower()
        if provider not in PROVIDER_PRESETS:
            raise ValueError(f"Unsupported provider: {provider}")
        preset = PROVIDER_PRESETS[provider]
        base_url = str(value.get("base_url") or preset["base_url"]).strip().rstrip("/")
        if preset["type"] == "openai_compatible" and not base_url:
            raise ValueError("An OpenAI-compatible base URL is required.")
        temperature = float(value.get("temperature", 0.4))
        if not 0 <= temperature <= 2:
            raise ValueError("temperature must be between 0 and 2")
        max_tokens = int(value.get("max_tokens", 16_384))
        if not 256 <= max_tokens <= 32_768:
            raise ValueError("max_tokens must be between 256 and 32768")
        reasoning_effort = str(value.get("reasoning_effort") or "default").strip().lower()
        if reasoning_effort not in REASONING_EFFORTS:
            raise ValueError(f"Unsupported reasoning effort: {reasoning_effort}")
        supported_efforts = {"default", *preset["reasoning_efforts"]}
        if reasoning_effort not in supported_efforts:
            raise ValueError(f"{preset['label']} does not support {reasoning_effort} reasoning.")
        return {
            "provider": provider,
            "model": str(value.get("model") or preset["default_model"]).strip(),
            "base_url": base_url,
            "reasoning_effort": reasoning_effort,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }


class CredentialStore:
    def __init__(self):
        self._memory = {}
        self._keyring_error = None

    def get(self, provider):
        if provider in self._memory:
            return self._memory[provider]
        env_name = ENV_KEYS.get(provider)
        if env_name and os.getenv(env_name):
            return os.getenv(env_name)
        try:
            import keyring

            return keyring.get_password(KEYRING_SERVICE, provider)
        except Exception as error:
            self._keyring_error = str(error)
            return None

    def set(self, provider, credential):
        if provider not in PROVIDER_PRESETS:
            raise ValueError(f"Unsupported provider: {provider}")
        if PROVIDER_PRESETS[provider]["type"] in {"claude_cli", "codex_cli"}:
            raise ValueError("Subscription credentials are managed by the provider CLI.")
        value = str(credential or "").strip()
        if not value:
            raise ValueError("Credential cannot be empty.")
        try:
            import keyring

            keyring.set_password(KEYRING_SERVICE, provider, value)
            self._memory.pop(provider, None)
            self._keyring_error = None
            return {"stored": True, "storage": "keychain", "persistent": True}
        except Exception as error:
            self._memory[provider] = value
            self._keyring_error = str(error)
            return {
                "stored": True,
                "storage": "memory",
                "persistent": False,
                "warning": "OS keychain unavailable; this credential lasts until ComfyUI restarts.",
            }

    def clear(self, provider):
        if provider not in PROVIDER_PRESETS:
            raise ValueError(f"Unsupported provider: {provider}")
        if PROVIDER_PRESETS[provider]["type"] in {"claude_cli", "codex_cli"}:
            raise ValueError("Subscription credentials are managed by the provider CLI.")
        self._memory.pop(provider, None)
        try:
            import keyring

            keyring.delete_password(KEYRING_SERVICE, provider)
        except Exception:
            pass

    def status(self, provider):
        source = None
        if provider in self._memory:
            source = "memory"
        elif ENV_KEYS.get(provider) and os.getenv(ENV_KEYS[provider]):
            source = "environment"
        else:
            try:
                import keyring

                if keyring.get_password(KEYRING_SERVICE, provider):
                    source = "keychain"
            except Exception as error:
                self._keyring_error = str(error)
        return {
            "configured": source is not None,
            "source": source,
            "keychain_available": self._keyring_error is None,
        }


def _cli_candidates(name):
    yield name
    if os.name == "nt" and os.getenv("APPDATA"):
        yield str(Path(os.getenv("APPDATA")) / "npm" / f"{name}.cmd")


def find_cli(name):
    for candidate in _cli_candidates(name):
        path = shutil.which(candidate) if candidate == name else candidate
        if path and Path(path).is_file():
            return str(Path(path).resolve())
    return None


async def _command(cli, *args, timeout=10):
    process = await asyncio.create_subprocess_exec(
        cli,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeError("Provider command timed out.") from None
    return process.returncode, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


class SubscriptionService:
    def __init__(self, provider):
        self.provider = provider
        self._status = None
        self._status_time = 0.0
        self._models = None
        self._models_time = 0.0

    @property
    def cli_name(self):
        return "codex" if self.provider == "codex_subscription" else "claude"

    async def status(self, refresh=False):
        now = time.monotonic()
        if not refresh and self._status is not None and now - self._status_time < 5:
            return dict(self._status)
        cli = find_cli(self.cli_name)
        if not cli:
            value = {
                "configured": False,
                "installed": False,
                "authenticated": False,
                "source": f"{self.cli_name}_cli",
                "message": f"{self.cli_name.title()} CLI is not installed or is not on PATH.",
            }
        elif self.provider == "codex_subscription":
            code, stdout, stderr = await _command(cli, "login", "status")
            text = f"{stdout}\n{stderr}".strip()
            authenticated = code == 0 and "chatgpt" in text.lower()
            value = {
                "configured": authenticated,
                "installed": True,
                "authenticated": code == 0,
                "source": "codex_cli",
                "authMethod": "chatgpt" if authenticated else ("api_key" if code == 0 else None),
                "message": "Codex is signed in with a ChatGPT subscription." if authenticated else "Run `codex login` and sign in with ChatGPT.",
            }
        else:
            code, stdout, _stderr = await _command(cli, "auth", "status")
            try:
                payload = json.loads(stdout) if code == 0 else {}
            except json.JSONDecodeError:
                payload = {}
            authenticated = bool(payload.get("loggedIn")) and payload.get("authMethod") == "claude.ai"
            value = {
                "configured": authenticated,
                "installed": True,
                "authenticated": bool(payload.get("loggedIn")),
                "source": "claude_cli",
                "authMethod": payload.get("authMethod"),
                "subscriptionType": payload.get("subscriptionType"),
                "message": "Claude Code is signed in with a Claude subscription." if authenticated else "Run `claude auth login` and sign in with Claude.ai.",
            }
        self._status = dict(value)
        self._status_time = now
        return value

    async def models(self, refresh=False):
        if self.provider != "codex_subscription":
            return deepcopy(PROVIDER_PRESETS[self.provider].get("models", []))
        now = time.monotonic()
        if not refresh and self._models is not None and now - self._models_time < 300:
            return deepcopy(self._models)
        cli = find_cli("codex")
        if not cli:
            return []
        code, stdout, _stderr = await _command(cli, "debug", "models", timeout=15)
        try:
            payload = json.loads(stdout) if code == 0 else {}
        except json.JSONDecodeError:
            payload = {}
        models = []
        seen = set()
        for item in payload.get("models", []) if isinstance(payload, dict) else []:
            model_id = str(item.get("slug") or "").strip()
            if item.get("visibility") != "list" or not model_id or model_id in seen:
                continue
            seen.add(model_id)
            model = {"id": model_id, "label": str(item.get("display_name") or model_id)}
            efforts = [
                str(option.get("effort"))
                for option in item.get("supported_reasoning_levels", [])
                if isinstance(option, dict) and option.get("effort")
            ]
            if efforts:
                model["reasoningEfforts"] = efforts
            if item.get("default_reasoning_level"):
                model["defaultReasoningEffort"] = item["default_reasoning_level"]
            models.append(model)
        counts = Counter(item["label"].casefold() for item in models)
        for item in models:
            if counts[item["label"].casefold()] > 1:
                item["label"] = f"{item['label']} · {item['id']}"
        self._models = deepcopy(models)
        self._models_time = now
        return models

    def launch_login(self):
        cli = find_cli(self.cli_name)
        if not cli:
            raise RuntimeError(f"{self.cli_name.title()} CLI is not installed or is not on PATH.")
        args = ["login"] if self.provider == "codex_subscription" else ["auth", "login"]
        command = " ".join([shlex.quote(cli), *args])
        system = platform.system()
        if system == "Windows":
            subprocess.Popen(
                ["cmd", "/c", "start", "", "cmd", "/k", command],
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
        elif system == "Darwin":
            script = f'tell application "Terminal" to do script {json.dumps(command)}'
            subprocess.Popen(["osascript", "-e", script])
        else:
            terminal = next((name for name in ("gnome-terminal", "konsole", "xterm") if shutil.which(name)), None)
            if not terminal or not os.getenv("DISPLAY"):
                raise RuntimeError(f"Open a terminal and run `{command}`.")
            subprocess.Popen([terminal, "--", "sh", "-lc", command])
        self._status = None
        return {"launched": True, "message": f"{self.cli_name.title()} login opened."}


async def connection_status(provider, refresh=False):
    preset = PROVIDER_PRESETS[provider]
    if preset["type"] == "codex_cli":
        return await codex_subscription.status(refresh)
    if preset["type"] == "claude_cli":
        return await claude_subscription.status(refresh)
    return credential_store.status(provider)


async def discover_models(settings, refresh=False):
    provider = settings["provider"]
    preset = PROVIDER_PRESETS[provider]
    if preset["type"] == "codex_cli":
        return await codex_subscription.models(refresh)
    if preset["type"] == "claude_cli":
        return await claude_subscription.models(refresh)
    if preset["type"] == "anthropic":
        model = settings["model"] or preset["default_model"]
        return [{"id": model, "label": model}]
    headers = {}
    credential = credential_store.get(provider)
    if credential:
        headers["Authorization"] = f"Bearer {credential}"
    timeout = aiohttp.ClientTimeout(total=15, connect=5)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{settings['base_url']}/models", headers=headers) as response:
                body = await response.json(content_type=None)
                if response.status < 200 or response.status >= 300:
                    raise ValueError(f"Model discovery failed with HTTP {response.status}.")
    except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not discover models: {error}") from error
    return [
        {"id": str(item["id"]), "label": str(item["id"])}
        for item in body.get("data", [])
        if isinstance(item, dict) and item.get("id")
    ]


writer_settings = WriterSettingsStore()
credential_store = CredentialStore()
codex_subscription = SubscriptionService("codex_subscription")
claude_subscription = SubscriptionService("claude_subscription")
