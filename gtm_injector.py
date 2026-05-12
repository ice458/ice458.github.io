import re
import sys
from pathlib import Path

# Make stdout tolerate non-cp932 chars on Windows (en-dashes in paths, etc.)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Google Tag Manager snippets
# 1) Consent Mode v2 default (must run BEFORE loading GTM)
CONSENT_DEFAULT_SNIPPET = (
    "<!-- Consent Mode default (runs before GTM) -->\n"
    "<script>\n"
    "  window.dataLayer = window.dataLayer || [];\n"
    "  function gtag(){dataLayer.push(arguments);}\n"
    "  // Force host-only cookies to avoid public suffix issues (e.g., github.io)\n"
    "  gtag('set','cookie_domain','none');\n"
    "  gtag('consent', 'default', {\n"
    "    ad_storage: 'denied',\n"
    "    analytics_storage: 'denied',\n"
    "    ad_user_data: 'denied',\n"
    "    ad_personalization: 'denied',\n"
    "    wait_for_update: 2000\n"
    "  });\n"
    "</script>\n"
)

# Standalone cookie domain override snippet (used when consent snippet already exists)
COOKIE_DOMAIN_SET_SNIPPET = (
    "<!-- Google Analytics cookie domain override (host-only) -->\n"
    "<script>\n"
    "  window.dataLayer = window.dataLayer || [];\n"
    "  function gtag(){dataLayer.push(arguments);}\n"
    "  gtag('set','cookie_domain','none');\n"
    "</script>\n"
)

# Geo override: auto-grant analytics for non-EEA/UK visitors.
# Runs after consent default (denied) and before GTM loader so the
# consent state is settled before any tag fires (wait_for_update covers timing).
CONSENT_GEO_SNIPPET = (
    "<!-- Consent geo override: auto-grant analytics outside EEA/UK -->\n"
    "<script>\n"
    "  (function(){\n"
    "    try {\n"
    "      var stored = null;\n"
    "      try { stored = localStorage.getItem('consent.choice'); } catch(e) {}\n"
    "      if (stored === 'denied') return;\n"
    "      if (stored === 'granted') {\n"
    "        gtag('consent','update',{\n"
    "          ad_storage:'granted', analytics_storage:'granted',\n"
    "          ad_user_data:'granted', ad_personalization:'granted'\n"
    "        });\n"
    "        return;\n"
    "      }\n"
    "      var tz = '';\n"
    "      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch(e) {}\n"
    "      var isEEA = /^Europe\\//.test(tz)\n"
    "               || tz === 'Asia/Nicosia'\n"
    "               || /^Atlantic\\/(Reykjavik|Madeira|Azores|Canary)$/.test(tz);\n"
    "      if (!isEEA) {\n"
    "        gtag('consent','update',{ analytics_storage:'granted' });\n"
    "      }\n"
    "    } catch(e) {}\n"
    "  })();\n"
    "</script>\n"
)
GEO_MARKER = "Consent geo override"

# 2) GTM loader snippet (must come AFTER consent default)
HEAD_SNIPPET = (
    "<!-- Google Tag Manager -->\n"
    "<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\n"
    "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\n"
    "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n"
    "'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);\n"
    "})(window,document,'script','dataLayer','GTM-MMZ5XH4V');</script>\n"
    "<!-- End Google Tag Manager -->\n"
)

BODY_SNIPPET = (
    "<!-- Google Tag Manager (noscript) -->\n"
    "<noscript><iframe src=\"https://www.googletagmanager.com/ns.html?id=GTM-MMZ5XH4V\"\n"
    "height=\"0\" width=\"0\" style=\"display:none;visibility:hidden\"></iframe></noscript>\n"
    "<!-- End Google Tag Manager (noscript) -->\n"
)

GTM_MARKER = "GTM-MMZ5XH4V"
# Use root-relative path so subdirectories can load the single shared script
CONSENT_JS_TAG = "<script src=\"/consent.js\" defer></script>"

# Whitespace-tolerant detection for `gtag('set','cookie_domain','none')`.
# Quotes may be ' or ", with arbitrary spaces between tokens.
COOKIE_DOMAIN_SET_RE = re.compile(
    r"cookie_domain\s*['\"]\s*,\s*['\"]\s*none\s*['\"]"
)

# Standalone cookie_domain block (comment + adjacent <script>...</script>).
# Used to dedupe accidental multiple insertions.
COOKIE_DOMAIN_BLOCK_RE = re.compile(
    r"<!--\s*Google Analytics cookie domain override \(host-only\)\s*-->\s*"
    r"<script\b[^>]*>.*?</script>\s*",
    re.DOTALL | re.IGNORECASE,
)


def _find_pre_gtm_insert_pos(text: str) -> int:
    """Return index where a snippet should be inserted right before the GTM loader.
    Returns -1 if no GTM loader is present in the document."""
    pos = text.find("<!-- Google Tag Manager -->")
    if pos != -1:
        return pos
    url_pos = text.find("https://www.googletagmanager.com/gtm.js?id=")
    if url_pos != -1:
        script_start = text.rfind("<script", 0, url_pos)
        return script_start if script_start != -1 else url_pos
    return -1


def _dedup_cookie_domain_blocks(text: str) -> tuple[str, bool]:
    """Collapse multiple standalone cookie_domain override blocks down to one.
    Keeps the first occurrence, drops the rest."""
    matches = list(COOKIE_DOMAIN_BLOCK_RE.finditer(text))
    if len(matches) <= 1:
        return text, False
    out: list[str] = []
    last_end = 0
    kept_first = False
    for m in matches:
        out.append(text[last_end:m.start()])
        if not kept_first:
            out.append(m.group(0))
            kept_first = True
        # else: drop this duplicate
        last_end = m.end()
    out.append(text[last_end:])
    return "".join(out), True


def should_skip(path: Path) -> bool:
    parts = {p for p in path.parts}
    # Skip common asset dump folders like *_files
    if any(str(p).endswith("_files") for p in parts):
        return True
    # Skip print-layout summary pages (kept intentionally lean — no GTM/SEO meta)
    name = path.name.lower()
    if re.fullmatch(r"summary\d*\.html?", name):
        return True
    return False


def inject_into_html(content: str) -> tuple[str, bool]:
    """Insert GTM head and noscript snippets where missing. Returns (new_content, changed)."""
    new_content = content
    changed = False

    has_head = (
        ("googletagmanager.com/gtm.js?id=" in new_content) and (GTM_MARKER in new_content)
    ) or ("<!-- Google Tag Manager -->" in new_content)
    has_noscript = (
        ("googletagmanager.com/ns.html?id=" in new_content) and (GTM_MARKER in new_content)
    ) or ("<!-- Google Tag Manager (noscript) -->" in new_content)

    # Ensure Consent default is present BEFORE GTM loader
    def has_consent_default(text: str) -> bool:
        return bool(re.search(r"gtag\(\s*['\"]consent['\"]\s*,\s*['\"]default['\"]", text))

    def inject_consent_before_gtm(text: str) -> tuple[str, bool]:
        if has_consent_default(text):
            changed_here = False
            # Ensure cookie_domain set exists somewhere (regex-based, whitespace-tolerant)
            if not COOKIE_DOMAIN_SET_RE.search(text):
                insert_pos = _find_pre_gtm_insert_pos(text)
                if insert_pos != -1:
                    text = text[:insert_pos] + COOKIE_DOMAIN_SET_SNIPPET + text[insert_pos:]
                    changed_here = True
                else:
                    head_open = re.search(r"<head[^>]*>", text, flags=re.IGNORECASE)
                    if head_open:
                        idx = head_open.end()
                        text = text[:idx] + "\n" + COOKIE_DOMAIN_SET_SNIPPET + text[idx:]
                        changed_here = True
            # Also bump wait_for_update to at least 2000ms to allow user action
            new_text = re.sub(r"(wait_for_update\s*:\s*)\d+", r"\g<1>2000", text)
            if new_text != text:
                text = new_text
                changed_here = True
            return text, changed_here
        # No consent default present: insert one right before the GTM loader
        insert_pos = _find_pre_gtm_insert_pos(text)
        if insert_pos != -1:
            return text[:insert_pos] + CONSENT_DEFAULT_SNIPPET + text[insert_pos:], True
        # Fallback: try to put into <head> start
        head_open = re.search(r"<head[^>]*>", text, flags=re.IGNORECASE)
        if head_open:
            idx = head_open.end()
            return text[:idx] + "\n" + CONSENT_DEFAULT_SNIPPET + text[idx:], True
        # As last resort, prepend
        return CONSENT_DEFAULT_SNIPPET + text, True

    # Insert into <head> if missing (GTM loader)
    if not has_head:
        head_open = re.search(r"<head[^>]*>", new_content, flags=re.IGNORECASE)
        if head_open:
            idx = head_open.end()
            # Insert consent default first, then GTM loader
            new_content = new_content[:idx] + "\n" + CONSENT_DEFAULT_SNIPPET + HEAD_SNIPPET + new_content[idx:]
            changed = True
        else:
            # Handle Jekyll front matter if present: starts with --- and ends with ---
            if new_content.lstrip().startswith("---"):
                fm_end = None
                lines = new_content.splitlines(keepends=True)
                dash_count = 0
                for i, ln in enumerate(lines):
                    if ln.strip() == "---":
                        dash_count += 1
                        if dash_count == 2:
                            fm_end = sum(len(l) for l in lines[: i + 1])
                            break
                if fm_end is not None:
                    new_content = new_content[:fm_end] + "\n" + CONSENT_DEFAULT_SNIPPET + HEAD_SNIPPET + new_content[fm_end:]
                    changed = True
            else:
                # Fallback: inject at very top
                new_content = CONSENT_DEFAULT_SNIPPET + HEAD_SNIPPET + new_content
                changed = True
    else:
        # GTM is present; ensure Consent default exists and is placed before GTM
        new_content, did_inject = inject_consent_before_gtm(new_content)
        changed = changed or did_inject

    # Ensure geo override snippet is present, placed right before GTM loader
    if GEO_MARKER not in new_content:
        insert_pos = _find_pre_gtm_insert_pos(new_content)
        if insert_pos != -1:
            new_content = new_content[:insert_pos] + CONSENT_GEO_SNIPPET + new_content[insert_pos:]
            changed = True

    # Insert noscript after <body> if missing
    if not has_noscript:
        body_open = re.search(r"<body[^>]*>", new_content, flags=re.IGNORECASE)
        if body_open:
            idx = body_open.end()
            new_content = new_content[:idx] + "\n" + BODY_SNIPPET + new_content[idx:]
            changed = True
        else:
            # If there's no <body>, try right after </head>
            head_close = re.search(r"</head>", new_content, flags=re.IGNORECASE)
            if head_close:
                idx = head_close.end()
                new_content = new_content[:idx] + "\n" + BODY_SNIPPET + new_content[idx:]
                changed = True
            else:
                # As a last resort, after the head snippet if present or at top
                head_pos = new_content.find(HEAD_SNIPPET)
                if head_pos != -1:
                    insert_pos = head_pos + len(HEAD_SNIPPET)
                    new_content = new_content[:insert_pos] + BODY_SNIPPET + new_content[insert_pos:]
                    changed = True
                else:
                    new_content = BODY_SNIPPET + new_content
                    changed = True

    # Ensure consent.js is loaded once before </body>
    if "consent.js" not in new_content:
        body_close = re.search(r"</body>", new_content, flags=re.IGNORECASE)
        if body_close:
            idx = body_close.start()
            new_content = new_content[:idx] + "\n  " + CONSENT_JS_TAG + "\n" + new_content[idx:]
            changed = True
        else:
            # append at end
            new_content = new_content + "\n" + CONSENT_JS_TAG + "\n"
            changed = True
    else:
        # Normalize any relative paths to root-relative
        replaced = new_content.replace('src="consent.js"','src="/consent.js"').replace("src='consent.js'","src='/consent.js'")
        if replaced != new_content:
            new_content = replaced
            changed = True

    # Collapse any duplicate standalone cookie_domain override blocks
    new_content, did_dedup = _dedup_cookie_domain_blocks(new_content)
    if did_dedup:
        changed = True

    return new_content, changed


def main():
    root = Path(__file__).parent
    targets = list(root.rglob("*.html")) + list(root.rglob("*.htm"))
    changed_files = []
    skipped = []
    for p in targets:
        if should_skip(p):
            skipped.append(p)
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            # As a last resort, read bytes and decode with replacement
            data = p.read_bytes()
            text = data.decode("utf-8", errors="ignore")

        new_text, changed = inject_into_html(text)
        if changed and new_text != text:
            p.write_text(new_text, encoding="utf-8")
            changed_files.append(p)

    print(f"Processed: {len(targets)} files")
    print(f"Changed:   {len(changed_files)} files")
    for f in changed_files:
        print(f" - {f.relative_to(root)}")
    if skipped:
        print(f"Skipped asset folders (*. _files): {len(skipped)} files")


if __name__ == "__main__":
    main()
