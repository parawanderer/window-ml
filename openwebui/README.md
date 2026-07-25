# OpenWebUI tools

Generic, reusable OpenWebUI **workspace Tools** for server-side execution — not
part of window.ml proper, just handy utilities that happen to live here. Because
they run server-side, they execute over OpenWebUI's `/api/chat/completions` API
(not only in the UI's agent loop), so window.ml can drive them via `toolIds`
when the extension is pointed at OpenWebUI instead of raw Ollama. Use them or
don't; nothing in the extension depends on them.

**Install:** in OpenWebUI, Workspace → Tools → **+** → paste a file's contents →
save. Each tool's `requirements:` header lists the pip packages it needs (the
OpenWebUI container installs them on save). Configure per-tool settings via its
**Valves** (gear icon); `UserValves` are per-user overrides.

## The tools

| File | Tool | What it does | Needs |
| --- | --- | --- | --- |
| `searxng_web_search.py` | **SearXNG Web Search** | Query a self-hosted SearXNG instance for ranked web results (title, URL, snippet). The cheap, wide step. | a SearXNG instance with JSON output; `requests` |
| `web_page_fetch.py` | **Web Page Fetch & Summarize** | Fetch one URL, strip it to readable text, and (by default) compress it against a focused question using a cheap local model before it reaches the calling model. The deep-dive step. | `requests`, `trafilatura`, `beautifulsoup4`; an OpenWebUI API key for summary mode |
| `youtube_video_info.py` | **YouTube Video Info & Transcript** | From a URL / video ID / "channel + title" search phrase: title, description, channel (name + link), views, likes, upload date, and the timestamped transcript — with the `&t=` moment highlighted. | `youtube-transcript-api`, `yt-dlp`, `requests` (all keyless) |

**Pairs:** the SearXNG search and the page fetch are two halves of one loop —
search wide for candidate URLs, then fetch/summarize the promising ones. The
YouTube tool is standalone (built for pasting a video, or a screenshot of one,
into a chat and discussing its contents).

**Notes:**
- The YouTube tool degrades to YouTube **oEmbed** (title + channel only) if
  `yt-dlp` is unavailable; description/stats/date/search need `yt-dlp`, and the
  transcript needs `youtube-transcript-api`. Transcript fetches can be
  IP-blocked by YouTube from cloud IPs — metadata still returns fine.
- The SearXNG tool exists because OpenWebUI's built-in "Web Search" is UI-only
  and never reaches the API (open-webui #12045); a workspace Tool does.
