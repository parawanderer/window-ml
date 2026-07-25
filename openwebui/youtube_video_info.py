"""
title: YouTube Video Info & Transcript

author: window.ml
git_url: https://github.com/parawanderer/window-ml

description: Given a YouTube URL, a bare video ID, or a "channel + title" search phrase, return the video's title, description, channel (name + link), view/like counts, upload date, and the timestamped transcript — with the exact segment highlighted when the URL carries a &t= timestamp. Metadata + search come from yt-dlp (no API key); the transcript comes from youtube-transcript-api; title/channel degrade gracefully to YouTube oEmbed if yt-dlp is unavailable. Built for pasting a video (or a screenshot of one) into a chat and discussing its contents.

requirements: youtube-transcript-api, yt-dlp, requests

version: 0.1.0

license: MIT
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import requests
from pydantic import BaseModel, Field

# youtube-transcript-api renamed/rearranged its exceptions across versions, so we
# import defensively and treat "any of these" as "no usable transcript" rather
# than hard-failing on an import that a given install doesn't ship.
try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api import (  # type: ignore
        TranscriptsDisabled,
        NoTranscriptFound,
    )

    _TRANSCRIPT_ERRORS: tuple = (TranscriptsDisabled, NoTranscriptFound)
except Exception:  # pragma: no cover - optional at runtime
    YouTubeTranscriptApi = None  # type: ignore
    _TRANSCRIPT_ERRORS = ()

try:
    import yt_dlp
except Exception:  # pragma: no cover - optional at runtime
    yt_dlp = None  # type: ignore

# A bare 11-char id, or an id embedded in any of the URL shapes YouTube uses.
_BARE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ID_IN_URL = re.compile(
    r"(?:v=|/embed/|/shorts/|/live/|youtu\.be/)([A-Za-z0-9_-]{11})"
)


def _parse_timestamp(raw: str) -> int | None:
    """
    Parse a YouTube `t` value into whole seconds. Accepts "623", "623s",
    "1h2m3s", "10m", "90s". Returns None if it can't.
    """
    raw = (raw or "").strip().lower()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", raw)
    if not m or not any(m.groups()):
        return None
    h, mm, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mm * 60 + s


def extract_video_id(url_or_id: str) -> tuple[str, int | None]:
    """
    Pull the 11-char video id and any &t= timestamp out of a URL or bare id.
    Returns (video_id, start_seconds_or_None). Raises ValueError if no id.
    """
    candidate = (url_or_id or "").strip()
    if not candidate:
        raise ValueError("No URL or video ID was provided.")
    if _BARE_ID.match(candidate):
        return candidate, None

    # Timestamp can live in the query (?t=) or, on some shares, the fragment (#t=).
    parsed = urlparse(candidate)
    qs = parse_qs(parsed.query)
    frag = parse_qs(parsed.fragment)
    t_raw = ""
    for src in (qs, frag):
        if src.get("t"):
            t_raw = src["t"][0]
            break
        if src.get("start"):
            t_raw = src["start"][0]
            break
    start = _parse_timestamp(t_raw)

    # Prefer the explicit ?v= param; else fall back to the path-based shapes.
    if qs.get("v") and _BARE_ID.match(qs["v"][0]):
        return qs["v"][0], start
    m = _ID_IN_URL.search(candidate)
    if m:
        return m.group(1), start
    raise ValueError(f"Couldn't find a YouTube video ID in: {url_or_id!r}")


def _fmt_ts(seconds: float | None) -> str:
    """Seconds → M:SS, or H:MM:SS past an hour. '?' if unknown."""
    if seconds is None:
        return "?"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _fmt_count(n: Any) -> str:
    """View/like count → grouped digits, or 'hidden' when the uploader hides it."""
    if n is None:
        return "hidden"
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n)


def _fmt_upload_date(raw: str | None) -> str:
    """yt-dlp gives upload_date as 'YYYYMMDD'; render it as 'YYYY-MM-DD'."""
    if raw and re.fullmatch(r"\d{8}", raw):
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return raw or "unknown"


def _watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _concise_transcript_error(e: Exception) -> str:
    """
    youtube-transcript-api raises multi-paragraph errors (the IP-ban one is ~300
    words of README). Boil the common cases down to one useful line so they don't
    flood the model's context.
    """
    msg = str(e)
    low = msg.lower()
    if "blocking requests from your ip" in low or "requestblocked" in low or "ipblocked" in low:
        return (
            "Transcript unavailable: YouTube is IP-blocking transcript requests from "
            "this server (common on cloud IPs, or after too many requests). The video's "
            "description/metadata above is still valid."
        )
    if "no element found" in low or "not available" in low:
        return "Transcript unavailable: none published for this video (or not in the requested language)."
    first = msg.strip().splitlines()[0] if msg.strip() else type(e).__name__
    return f"Transcript fetch failed: {first[:200]}"


# --- Blocking workers (run via asyncio.to_thread) ---------------------------


def _ytdlp_info(video_id: str) -> dict[str, Any]:
    """Full metadata for one video via yt-dlp. Raises on failure."""
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed.")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(_watch_url(video_id), download=False)


def _ytdlp_search(query: str, count: int) -> list[dict[str, Any]]:
    """Flat (cheap, un-hydrated) search results via yt-dlp's ytsearch."""
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed.")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,  # don't hydrate every hit — just id/title/channel
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        res = ydl.extract_info(f"ytsearch{count}:{query}", download=False)
    return [e for e in (res.get("entries") or []) if e]


def _oembed_info(video_id: str, timeout: int) -> dict[str, Any]:
    """
    Lightweight fallback: YouTube oEmbed gives title + channel (name & link) with
    no API key and no yt-dlp. It has NO description / views / likes / date.
    """
    resp = requests.get(
        "https://www.youtube.com/oembed",
        params={"url": _watch_url(video_id), "format": "json"},
        timeout=timeout,
        headers={"User-Agent": "OpenWebUI-YouTube-Tool"},
    )
    resp.raise_for_status()
    return resp.json()


def _fetch_transcript(video_id: str, languages: list[str]) -> list[dict[str, Any]]:
    """
    Timestamped transcript segments via youtube-transcript-api. Returns a list of
    {start, duration, text}. Raises on no-transcript / disabled.
    """
    if YouTubeTranscriptApi is None:
        raise RuntimeError("youtube-transcript-api is not installed.")
    # The library's constructor/instance shape changed across versions; support both.
    try:
        api = YouTubeTranscriptApi()
        fetched = api.fetch(video_id, languages=languages)
    except TypeError:
        # Older static-method style.
        fetched = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)  # type: ignore

    segments = []
    for snip in fetched:
        if isinstance(snip, dict):
            start, duration, text = snip.get("start"), snip.get("duration"), snip.get("text", "")
        else:  # FetchedTranscriptSnippet object
            start = getattr(snip, "start", None)
            duration = getattr(snip, "duration", None)
            text = getattr(snip, "text", "")
        text = (text or "").replace("\n", " ").strip()
        if text:
            segments.append({"start": start, "duration": duration, "text": text})
    return segments


class Tools:
    class Valves(BaseModel):
        MAX_TRANSCRIPT_CHARS: int = Field(
            default=24000,
            description=(
                "Cap on the transcript text returned to the model (a long video's "
                "transcript can blow past a small context window). Truncated with a note."
            ),
        )
        SEARCH_RESULTS: int = Field(
            default=5,
            description="How many candidates to return when finding a video by search phrase.",
        )
        INCLUDE_TRANSCRIPT_BY_DEFAULT: bool = Field(
            default=True,
            description="Fetch the transcript unless the model explicitly asks not to.",
        )
        ANCHOR_CONTEXT: int = Field(
            default=4,
            description=(
                "When the URL has a &t= timestamp, how many transcript lines of context to "
                "quote on each side of the linked moment in the highlighted excerpt."
            ),
        )
        TIMEOUT: int = Field(default=20, description="HTTP timeout for oEmbed, seconds.")

    class UserValves(BaseModel):
        TRANSCRIPT_LANGUAGE: str = Field(
            default="en",
            description="Comma-separated transcript languages, highest priority first (e.g. 'en, es').",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def get_youtube_video(
        self,
        url: str = "",
        search: str = "",
        include_transcript: bool = True,
        __event_emitter__: Callable[[dict], Any] | None = None,
        __user__: dict | None = None,
    ) -> str:
        """
        Look up a YouTube video and return its details plus a timestamped transcript,
        so you can discuss the video's actual contents. Give EITHER a `url` (or bare
        video ID) OR a `search` phrase — not both. If the URL contains a &t= timestamp,
        the transcript line at that moment is highlighted.

        :param url: A YouTube URL (long https://www.youtube.com/watch?v=ID, short
            https://youtu.be/ID, /shorts/, /embed/), optionally with a &t=623s timestamp,
            or a bare 11-character video ID. Use this whenever the user pasted a link.
        :param search: A "channel name + video title" phrase to find the video when you
            have no URL (e.g. "Veritasium the map of physics"). Returns the top matches;
            pick one and call again with its URL to get the transcript.
        :param include_transcript: Whether to fetch the (timestamped) transcript. Set
            false if you only need metadata, or the transcript is too long to be useful.
        :return: A formatted report (title, description, channel, stats, transcript), a
            ranked candidate list for a search, or an error message.
        """

        async def emit(desc: str, status: str = "in_progress", done: bool = False):
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": desc, "status": status, "done": done},
                    }
                )

        async def cite(title: str, url_: str, text: str):
            if __event_emitter__ and url_:
                await __event_emitter__(
                    {
                        "type": "citation",
                        "data": {
                            "document": [text or title or url_],
                            "metadata": [{"source": url_}],
                            "source": {"name": title or url_},
                        },
                    }
                )

        url = (url or "").strip()
        search = (search or "").strip()

        # --- Search branch: find candidates, hand back to the model to pick -----
        if search and not url:
            if yt_dlp is None:
                return (
                    "Can't search: yt-dlp is not installed (it's what does keyless "
                    "YouTube search). Install it, or pass a direct video URL instead."
                )
            await emit(f"Searching YouTube for: {search}")
            try:
                hits = await asyncio.to_thread(
                    _ytdlp_search, search, max(1, self.valves.SEARCH_RESULTS)
                )
            except Exception as e:
                await emit(f"Search failed: {e}", "error", True)
                return f"YouTube search failed: {e}"
            if not hits:
                await emit("No results.", "success", True)
                return f"No YouTube videos found for: {search}"

            lines = []
            for i, h in enumerate(hits, 1):
                vid = h.get("id") or ""
                title = h.get("title") or "(untitled)"
                channel = h.get("channel") or h.get("uploader") or "unknown channel"
                dur = _fmt_ts(h.get("duration")) if h.get("duration") else "?"
                views = _fmt_count(h.get("view_count"))
                lines.append(
                    f"{i}. {title}\n   {channel} · {dur} · {views} views\n   {_watch_url(vid)}"
                )
            await emit(f"Found {len(hits)} candidate(s).", "success", True)
            return (
                f"Search results for “{search}” (pick one and call this tool again with "
                f"its URL to get the description + transcript):\n\n" + "\n".join(lines)
            )

        if not url:
            return (
                "Provide either `url` (a YouTube link or 11-char video ID) or `search` "
                "(a channel + title phrase to look it up)."
            )

        # --- Direct branch: resolve id + optional timestamp --------------------
        try:
            video_id, anchor = extract_video_id(url)
        except ValueError as e:
            await emit(str(e), "error", True)
            return f"Error: {e}"
        if video_id == "dQw4w9WgXcQ":
            return "That's the Rick Roll. Sure you want it?"

        watch = _watch_url(video_id)
        await emit(f"Fetching video info: {video_id}")

        # Metadata: prefer yt-dlp (full), fall back to oEmbed (title + channel only).
        meta: dict[str, Any] = {}
        meta_source = ""
        info: dict[str, Any] | None = None
        if yt_dlp is not None:
            try:
                info = await asyncio.to_thread(_ytdlp_info, video_id)
                meta_source = "yt-dlp"
            except Exception as e:
                info = None
                await emit(f"yt-dlp failed ({e}); trying oEmbed…")
        if info:
            meta = {
                "title": info.get("title"),
                "description": info.get("description"),
                "channel": info.get("channel") or info.get("uploader"),
                "channel_url": info.get("channel_url") or info.get("uploader_url"),
                "views": info.get("view_count"),
                "likes": info.get("like_count"),
                "upload_date": _fmt_upload_date(info.get("upload_date")),
                "duration": info.get("duration"),
            }
        else:
            try:
                o = await asyncio.to_thread(_oembed_info, video_id, self.valves.TIMEOUT)
                meta = {
                    "title": o.get("title"),
                    "channel": o.get("author_name"),
                    "channel_url": o.get("author_url"),
                }
                meta_source = "oEmbed (limited: no description/stats/date)"
            except Exception as e:
                await emit(f"Couldn't fetch video info: {e}", "error", True)
                return (
                    f"Couldn't fetch info for {watch}: {e}. "
                    f"(Metadata needs yt-dlp; oEmbed also failed.)"
                )

        # --- Transcript --------------------------------------------------------
        want_transcript = include_transcript and self.valves.INCLUDE_TRANSCRIPT_BY_DEFAULT
        segments: list[dict[str, Any]] = []
        transcript_error = ""
        if want_transcript:
            langs = self._languages(__user__)
            await emit(f"Fetching transcript ({', '.join(langs)})…")
            try:
                segments = await asyncio.to_thread(_fetch_transcript, video_id, langs)
            except _TRANSCRIPT_ERRORS as e:  # type: ignore
                transcript_error = f"No transcript available ({type(e).__name__})."
            except Exception as e:
                transcript_error = _concise_transcript_error(e)

        report = self._render(meta, meta_source, watch, anchor, segments, transcript_error)
        await cite(meta.get("title") or watch, watch, (meta.get("description") or "")[:500])
        await emit("Done.", "success", True)
        return report

    # --- helpers ---------------------------------------------------------------

    def _languages(self, __user__: dict | None) -> list[str]:
        pref = "en"
        try:
            uv = (__user__ or {}).get("valves")
            if uv is not None:
                pref = getattr(uv, "TRANSCRIPT_LANGUAGE", pref) or pref
        except Exception:
            pass
        langs = [x.strip() for x in str(pref).split(",") if x.strip()]
        if "en" not in langs:
            langs.append("en")  # English is a near-universal fallback
        return langs

    def _render(
        self,
        meta: dict[str, Any],
        meta_source: str,
        watch: str,
        anchor: int | None,
        segments: list[dict[str, Any]],
        transcript_error: str,
    ) -> str:
        out: list[str] = []
        out.append(f"# {meta.get('title') or '(no title)'}")
        out.append(f"URL: {watch}")

        channel = meta.get("channel")
        if channel:
            link = meta.get("channel_url")
            out.append(f"Channel: {channel}" + (f" ({link})" if link else ""))

        stats = []
        if "views" in meta:
            stats.append(f"{_fmt_count(meta.get('views'))} views")
        if "likes" in meta:
            stats.append(f"{_fmt_count(meta.get('likes'))} likes")
        if meta.get("upload_date"):
            stats.append(f"uploaded {meta['upload_date']}")
        if meta.get("duration"):
            stats.append(f"length {_fmt_ts(meta['duration'])}")
        if stats:
            out.append(" · ".join(stats))

        if meta.get("description"):
            out.append("\n## Description\n" + str(meta["description"]).strip())

        # Highlighted anchor excerpt, when the link pointed at a moment.
        if anchor is not None:
            out.append(f"\n▶ Linked timestamp: {_fmt_ts(anchor)} ({anchor}s)")
            if segments:
                excerpt = self._anchor_excerpt(segments, anchor)
                if excerpt:
                    out.append("Around that moment:\n" + excerpt)

        # Full (capped) timestamped transcript.
        if transcript_error:
            out.append("\n## Transcript\n" + transcript_error)
        elif segments:
            body, truncated = self._transcript_block(segments, anchor)
            head = "## Transcript (timestamped)"
            if truncated:
                head += "  — truncated to fit; ask for a specific timestamp range for more"
            out.append("\n" + head + "\n" + body)
        elif meta_source.startswith("oEmbed"):
            out.append("\n(Transcript skipped — running in oEmbed fallback mode.)")

        if meta_source:
            out.append(f"\n_source: {meta_source}_")
        return "\n".join(out)

    def _nearest_index(self, segments: list[dict[str, Any]], t: int) -> int:
        """Index of the segment covering (or nearest to) t seconds."""
        best_i, best_d = 0, float("inf")
        for i, s in enumerate(segments):
            start = s.get("start")
            if start is None:
                continue
            end = start + (s.get("duration") or 0)
            if start <= t < end:
                return i
            d = abs(start - t)
            if d < best_d:
                best_i, best_d = i, d
        return best_i

    def _anchor_excerpt(self, segments: list[dict[str, Any]], t: int) -> str:
        idx = self._nearest_index(segments, t)
        ctx = max(0, self.valves.ANCHOR_CONTEXT)
        lo, hi = max(0, idx - ctx), min(len(segments), idx + ctx + 1)
        lines = []
        for i in range(lo, hi):
            s = segments[i]
            marker = "→ " if i == idx else "  "
            lines.append(f"{marker}[{_fmt_ts(s.get('start'))}] {s['text']}")
        return "\n".join(lines)

    def _transcript_block(
        self, segments: list[dict[str, Any]], anchor: int | None
    ) -> tuple[str, bool]:
        cap = self.valves.MAX_TRANSCRIPT_CHARS
        anchor_idx = self._nearest_index(segments, anchor) if anchor is not None else -1
        lines, total, truncated = [], 0, False
        for i, s in enumerate(segments):
            marker = "→ " if i == anchor_idx else ""
            line = f"[{_fmt_ts(s.get('start'))}] {marker}{s['text']}"
            if total + len(line) + 1 > cap:
                truncated = True
                break
            lines.append(line)
            total += len(line) + 1
        return "\n".join(lines), truncated


if __name__ == "__main__":
    # Quick offline-ish CLI: python youtube_video_info.py "<url|id|search>"
    import argparse
    import json

    parser = argparse.ArgumentParser(description="YouTube video info + transcript.")
    parser.add_argument("target", help="A YouTube URL, an 11-char ID, or a search phrase")
    parser.add_argument("--search", action="store_true", help="Treat target as a search phrase")
    parser.add_argument("--no-transcript", action="store_true", help="Skip the transcript")
    parser.add_argument("--lang", default="en", help="Transcript languages, comma-separated")
    args = parser.parse_args()

    tool = Tools()

    class _UV:
        TRANSCRIPT_LANGUAGE = args.lang

    result = asyncio.run(
        tool.get_youtube_video(
            url="" if args.search else args.target,
            search=args.target if args.search else "",
            include_transcript=not args.no_transcript,
            __user__={"valves": _UV()},
        )
    )
    print(result)
