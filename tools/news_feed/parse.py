"""Read RSS/Atom metadata only. Feed text is data and is never executed."""
import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import json
from pathlib import Path
import unicodedata
from urllib.parse import urljoin, urlsplit
import xml.etree.ElementTree as ET

MAX_BYTES = 2 * 1024 * 1024
XML_BASE = "{http://www.w3.org/XML/1998/namespace}base"


class FeedTreeBuilder(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.elements = 0

    def start(self, tag, attrs):
        self.depth += 1
        self.elements += 1
        if self.depth > 50 or self.elements > 100000:
            raise ValueError("XML 层级或节点数量超过限制。")
        return super().start(tag, attrs)

    def end(self, tag):
        value = super().end(tag)
        self.depth -= 1
        return value

    def doctype(self, name, pubid, system):
        raise ValueError("资讯 XML 不允许 DOCTYPE 或实体声明。")


def local_name(tag):
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def children(element, name):
    return [child for child in element if local_name(child.tag) == name]


def first(element, name):
    return next((child for child in element if local_name(child.tag) == name), None)


class HTMLTitleText(HTMLParser):
    separators = {"br", "p", "div", "li", "ul", "ol", "blockquote", "pre",
                  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "tr", "td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = ""

    def handle_starttag(self, tag, attrs):
        if self.hidden:
            return
        if tag in ("script", "style"):
            self.hidden = tag
        elif tag in self.separators:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden:
                self.hidden = ""
        elif tag in self.separators:
            self.parts.append(" ")

    def handle_startendtag(self, tag, attrs):
        if not self.hidden and tag in self.separators:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(element, limit=120, atom_text=False):
    if element is None:
        return ""
    value = "".join(element.itertext())
    # Atom HTML is escaped in XML and needs one additional HTML text pass.
    # Text titles and XHTML child text must not be interpreted as HTML again.
    if atom_text and element.get("type", "text").lower() == "html":
        parser = HTMLTitleText()
        parser.feed(value)
        parser.close()
        value = "".join(parser.parts)
    value = unicodedata.normalize("NFKC", value)
    value = " ".join(value.split())
    return value if limit is None else value[:limit]


def date_value(value):
    if not value:
        return None
    try:
        result = parsedate_to_datetime(value)
    except (ValueError, TypeError, OverflowError):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (ValueError, TypeError, OverflowError):
            return None
    # A missing timezone is ambiguous; never invent the publication time.
    if result is None or result.tzinfo is None:
        return None
    try:
        return result.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def safe_link(value, base):
    if not value or len(value) > 4096:
        return ""
    try:
        resolved = urljoin(base, value.strip())
        parsed = urlsplit(resolved)
        if (parsed.scheme not in ("https", "http") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443 if parsed.scheme == "https" else 80)):
            return ""
        return parsed._replace(fragment="").geturl()
    except ValueError:
        return ""


def entry_link(entry, base, atom=False):
    for link in children(entry, "link"):
        if atom:
            if link.get("rel", "alternate") != "alternate":
                continue
            value = link.get("href", "")
        else:
            value = plain(link, 4096)
        resolved = safe_link(value, urljoin(base, link.get(XML_BASE, "")))
        if resolved:
            return resolved
    return ""


def parse_feed(data, feed_url, keywords, now):
    if not data or len(data) > MAX_BYTES:
        raise ValueError("资讯 XML 为空或超过 2MB。")
    # Removing NUL bytes also detects declarations in UTF-16/UTF-32 input.
    # XML itself is parsed by ElementTree, never by a regular expression.
    declarations = data.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
        raise ValueError("资讯 XML 不允许 DOCTYPE 或实体声明。")
    root = ET.fromstring(data, parser=ET.XMLParser(target=FeedTreeBuilder()))
    kind = local_name(root.tag)
    atom = kind == "feed"
    if atom:
        channel, entries = root, children(root, "entry")
    elif kind in ("rss", "rdf"):
        channel = first(root, "channel")
        if channel is None:
            raise ValueError("RSS 缺少 channel。")
        entries = children(channel, "item") if kind == "rss" else children(root, "item")
    else:
        raise ValueError("来源不是 RSS / Atom XML。")
    feed_title = plain(first(channel, "title"), atom_text=atom) or urlsplit(feed_url).hostname
    root_base = urljoin(feed_url, root.get(XML_BASE, ""))
    channel_base = urljoin(root_base, channel.get(XML_BASE, "")) if channel is not root else root_base
    terms = [unicodedata.normalize("NFKC", term).casefold().strip()
             for term in keywords.replace("，", ",").split(",") if term.strip()]
    items = []
    missing_date = missing_link = outside_window = long_title = 0
    for entry in entries:
        title = plain(first(entry, "title"), limit=None, atom_text=atom)
        if len(title) > 120:
            long_title += 1
            continue
        if not title or terms and not any(term in title.casefold() for term in terms):
            continue
        published = None
        for name in (("published", "updated") if atom else ("pubdate", "date")):
            published = date_value(plain(first(entry, name), 160))
            if published is not None:
                break
        if published is None:
            missing_date += 1
            continue
        if published < now - timedelta(hours=48) or published > now + timedelta(minutes=10):
            outside_window += 1
            continue
        base = urljoin(channel_base, entry.get(XML_BASE, ""))
        link = entry_link(entry, base, atom)
        if not link:
            missing_link += 1
            continue
        source = first(entry, "source")
        source_name, source_url = feed_title, feed_url
        if source is not None:
            source_name = plain(first(source, "title") if atom else source, atom_text=atom) or feed_title
            source_url = (entry_link(source, base, True) if atom
                          else safe_link(source.get("url", ""), base)) or feed_url
        items.append({"title": title, "url": link, "publishedAt": published.isoformat().replace("+00:00", "Z"),
                      "sourceName": source_name, "sourceUrl": source_url})
    items.sort(key=lambda item: date_value(item["publishedAt"]), reverse=True)
    unique, seen, seen_urls = [], set(), set()
    for item in items:
        key = "".join(item["title"].casefold().split())
        if key not in seen and item["url"] not in seen_urls:
            seen.add(key)
            seen_urls.add(item["url"])
            unique.append(item)
            if len(unique) == 60:
                break
    warnings = []
    if long_title:
        warnings.append(f"{long_title} 条资讯标题超过 120 字，已跳过；未截断标题。")
    if missing_date:
        warnings.append(f"{missing_date} 条资讯没有明确日期和时区，已跳过。")
    if missing_link:
        warnings.append(f"{missing_link} 条资讯没有可用来源链接，已跳过。")
    if outside_window:
        warnings.append(f"{outside_window} 条资讯不在最近 48 小时内或日期超前，已跳过。")
    return {"feedTitle": feed_title, "items": unique, "warnings": warnings}


if __name__ == "__main__":
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--input", required=True)
    argument_parser.add_argument("--url", required=True)
    argument_parser.add_argument("--keywords", default="")
    argument_parser.add_argument("--now", required=True)
    args = argument_parser.parse_args()
    clock = date_value(args.now)
    if clock is None:
        argument_parser.error("检查时间无效。")
    with Path(args.input).open("rb") as source_file:
        raw = source_file.read(MAX_BYTES + 1)
    print(json.dumps(parse_feed(raw, args.url, args.keywords, clock), ensure_ascii=False))
