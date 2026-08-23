import hashlib
import os
from functools import lru_cache
from pathlib import Path

import av
import torch

import folder_paths
from comfy_extras.nodes_audio import f32_pcm, load


def available_audio_files():
    input_dir = Path(folder_paths.get_input_directory()).resolve()
    os.makedirs(input_dir, exist_ok=True)
    files, _ = folder_paths.recursive_search(str(input_dir))
    media_files = folder_paths.filter_files_content_types(files, ["audio", "video"])
    result = []
    for filename in media_files:
        path = (input_dir / filename).resolve()
        try:
            path.relative_to(input_dir)
        except ValueError:
            continue
        if path.is_file():
            result.append(Path(filename).as_posix())
    return sorted(result, key=str.casefold)


def audio_library_entries():
    input_dir = Path(folder_paths.get_input_directory()).resolve()
    entries = []
    for filename in available_audio_files():
        path = (input_dir / filename).resolve()
        stat = path.stat()
        relative = Path(filename)
        entries.append({
            "path": relative.as_posix(),
            "folder": relative.parent.as_posix() if relative.parent != Path(".") else "",
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })
    return entries


def resolve_audio_path(filename):
    if not filename:
        raise ValueError("Choose an audio file or connect beat_positions.")
    if not folder_paths.exists_annotated_filepath(filename):
        raise ValueError(f"Audio file does not exist: {filename}")

    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    input_dir = Path(folder_paths.get_input_directory()).resolve()
    try:
        path.relative_to(input_dir)
    except ValueError as error:
        raise ValueError("Audio files must be inside the ComfyUI input directory.") from error
    if not path.is_file():
        raise ValueError(f"Audio file does not exist: {filename}")
    return path


@lru_cache(maxsize=128)
def _audio_file_hash(path, size, modified_ns):
    digest = hashlib.sha256()
    with open(path, "rb") as audio_file:
        for chunk in iter(lambda: audio_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audio_file_hash(path):
    path = Path(path)
    stat = path.stat()
    return _audio_file_hash(str(path), stat.st_size, stat.st_mtime_ns)


def load_audio_file(filename):
    path = resolve_audio_path(filename)
    waveform, sample_rate = load(str(path))
    return path, {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}


def _full_audio_file_range(path, start_sample, sample_count):
    waveform, sample_rate = load(str(path))
    end_sample = start_sample + sample_count
    if end_sample > waveform.shape[-1]:
        raise ValueError("The requested audio range extends past the end of the file.")
    return {
        "waveform": waveform[:, start_sample:end_sample].clone().unsqueeze(0),
        "sample_rate": sample_rate,
    }


def load_audio_file_range(filename, start_sample, sample_count):
    if start_sample < 0 or sample_count <= 0:
        raise ValueError("Audio range samples must be positive and start at zero or later.")
    path = resolve_audio_path(filename)
    with av.open(str(path)) as audio_file:
        if not audio_file.streams.audio:
            raise ValueError("No audio stream found in the file.")
        stream = audio_file.streams.audio[0]
        sample_rate = stream.codec_context.sample_rate
        channels = stream.channels
        stream_start = stream.start_time or 0
        seek_sample = max(0, start_sample - sample_rate)
        seek_timestamp = stream_start + int(seek_sample / sample_rate / float(stream.time_base))
        try:
            audio_file.seek(seek_timestamp, stream=stream, backward=True)
        except av.FFmpegError:
            return path, _full_audio_file_range(path, start_sample, sample_count)

        end_sample = start_sample + sample_count
        frames = []
        for frame in audio_file.decode(streams=stream.index):
            if frame.pts is None:
                continue
            frame_start = round(
                (frame.pts - stream_start) * float(frame.time_base) * sample_rate
            )
            samples = torch.from_numpy(frame.to_ndarray())
            if samples.shape[0] != channels:
                samples = samples.view(-1, channels).t()
            frame_end = frame_start + samples.shape[1]
            if frame_end <= start_sample:
                continue
            if frame_start >= end_sample:
                break
            left = max(0, start_sample - frame_start)
            right = min(samples.shape[1], end_sample - frame_start)
            if right > left:
                frames.append(samples[:, left:right])
            if frame_end >= end_sample:
                break

    if not frames:
        return path, _full_audio_file_range(path, start_sample, sample_count)
    waveform = f32_pcm(torch.cat(frames, dim=1))
    if waveform.shape[-1] != sample_count:
        return path, _full_audio_file_range(path, start_sample, sample_count)
    return path, {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
