import base64
import io
import re
import warnings
from dataclasses import dataclass
from pathlib import Path

import folder_paths
from PIL import Image, ImageOps, UnidentifiedImageError


MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
MAX_DECODED_PIXELS = 64_000_000
MAX_VISION_BYTES = 450_000
MAX_VISION_DIMENSION = 2048
MIN_VISION_DIMENSION = 256
ALLOWED_MIME_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}
UPLOAD_ROOT = "fl-beat-writer"


@dataclass(frozen=True, slots=True)
class PromptWriterImage:
    data: str
    media_type: str
    label: str
    original_size: tuple[int, int]
    preview_size: tuple[int, int]

    @property
    def data_url(self):
        return f"data:{self.media_type};base64,{self.data}"


def writer_upload_subfolder(scheduler_id):
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(scheduler_id or "")).strip("-")[:80]
    return f"{UPLOAD_ROOT}/{value or 'scheduler'}"


def _resolve_attachment_path(filename, subfolder):
    root = Path(folder_paths.get_input_directory()).resolve()
    candidate = (root / subfolder / filename).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("Attachment is outside the ComfyUI input folder.") from error
    if not candidate.is_file():
        raise ValueError(f"Attached image was not found: {filename}")
    return candidate


def normalize_prompt_writer_attachments(value, scheduler_id):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("attachments must be a list.")
    if len(value) > MAX_ATTACHMENTS:
        raise ValueError(f"Attach at most {MAX_ATTACHMENTS} images per message.")

    expected_subfolder = writer_upload_subfolder(scheduler_id)
    normalized = []
    for position, item in enumerate(value, 1):
        if not isinstance(item, dict):
            raise ValueError(f"Attachment {position} is invalid.")
        filename = str(item.get("filename") or "").strip()
        subfolder = str(item.get("subfolder") or "").strip().replace("\\", "/")
        image_type = str(item.get("type") or "input").strip().lower()
        if (
            not filename
            or len(filename) > 255
            or Path(filename).name != filename
            or filename in {".", ".."}
        ):
            raise ValueError(f"Attachment {position} has an invalid filename.")
        if subfolder != expected_subfolder:
            raise ValueError(f"Attachment {position} is outside this Beat Writer's upload folder.")
        if image_type != "input":
            raise ValueError(f"Attachment {position} must be a ComfyUI input image.")
        mime_type = str(item.get("mimeType") or "").strip().lower()
        if mime_type and mime_type not in ALLOWED_MIME_TYPES:
            raise ValueError(f"Attachment {position} is not a supported image.")
        path = _resolve_attachment_path(filename, subfolder)
        size_bytes = path.stat().st_size
        if size_bytes <= 0 or size_bytes > MAX_ATTACHMENT_BYTES:
            raise ValueError(f"Attachment {position} exceeds the 32 MB limit.")
        try:
            width = int(item.get("width") or 0)
            height = int(item.get("height") or 0)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"Attachment {position} has invalid dimensions.") from error
        if width < 0 or height < 0 or width > 100_000 or height > 100_000:
            raise ValueError(f"Attachment {position} has invalid dimensions.")
        normalized.append({
            "filename": filename,
            "subfolder": subfolder,
            "type": "input",
            "originalName": str(item.get("originalName") or filename).strip()[:255] or filename,
            "mimeType": mime_type,
            "sizeBytes": size_bytes,
            "width": width,
            "height": height,
        })
    return normalized


def _visible_transparency(image):
    if "A" in image.getbands():
        return image.getchannel("A").getextrema()[0] < 255
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA").getchannel("A").getextrema()[0] < 255
    return False


def _encode_vision_preview(image):
    preserve_alpha = _visible_transparency(image)
    target_dimension = MAX_VISION_DIMENSION
    while True:
        preview = image.copy()
        preview.thumbnail((target_dimension, target_dimension), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        if preserve_alpha:
            preview.save(buffer, format="PNG", optimize=True)
            media_type = "image/png"
        else:
            preview.convert("RGB").save(buffer, format="JPEG", quality=88, optimize=True)
            media_type = "image/jpeg"
        content = buffer.getvalue()
        current_dimension = max(preview.size)
        if len(content) <= MAX_VISION_BYTES or current_dimension <= MIN_VISION_DIMENSION:
            return content, media_type, preview.size
        scale = min(0.9, max(0.5, (MAX_VISION_BYTES / len(content)) ** 0.5 * 0.92))
        target_dimension = max(MIN_VISION_DIMENSION, int(current_dimension * scale))


def load_prompt_writer_image(attachment):
    path = _resolve_attachment_path(attachment["filename"], attachment["subfolder"])
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                original_size = source.size
                if original_size[0] * original_size[1] > MAX_DECODED_PIXELS:
                    raise ValueError(
                        f"{attachment['originalName']} exceeds the {MAX_DECODED_PIXELS:,}-pixel limit."
                    )
                source.seek(0)
                image = ImageOps.exif_transpose(source).copy()
    except ValueError:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError(f"{attachment['originalName']} is not a readable image.") from error
    except Image.DecompressionBombWarning as error:
        raise ValueError(f"{attachment['originalName']} has unsafe image dimensions.") from error
    content, media_type, preview_size = _encode_vision_preview(image)
    return PromptWriterImage(
        data=base64.b64encode(content).decode("ascii"),
        media_type=media_type,
        label=attachment["originalName"],
        original_size=original_size,
        preview_size=preview_size,
    )


def load_prompt_writer_images(attachments):
    return [load_prompt_writer_image(attachment) for attachment in attachments]
