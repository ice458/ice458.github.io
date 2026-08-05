#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Liquid テンプレート言語の、このサイトで使う部分だけを実装したもの。

方針: 未知のタグ・未知のフィルタは「黙って空文字」にせず必ず例外にする。
      本家 Jekyll との差異を静かに飲み込むと検証の意味が無くなるため。
"""
import json
import re


class LiquidError(Exception):
    pass


# ---------------------------------------------------------------- 字句解析

TOKEN_RE = re.compile(r"(\{\{-?.*?-?\}\}|\{%-?.*?-?%\})", re.DOTALL)


class Tok:
    def __init__(self, kind, value, lstrip=False, rstrip=False):
        self.kind = kind          # 'text' | 'var' | 'tag'
        self.value = value
        self.lstrip = lstrip
        self.rstrip = rstrip

    def __repr__(self):
        return f"Tok({self.kind}, {self.value!r})"


def tokenize(src):
    toks = []
    for part in TOKEN_RE.split(src):
        if not part:
            continue
        if part.startswith("{{"):
            inner = part[2:-2]
            ls = inner.startswith("-")
            rs = inner.endswith("-")
            toks.append(Tok("var", inner.strip("-").strip(), ls, rs))
        elif part.startswith("{%"):
            inner = part[2:-2]
            ls = inner.startswith("-")
            rs = inner.endswith("-")
            toks.append(Tok("tag", inner.strip("-").strip(), ls, rs))
        else:
            toks.append(Tok("text", part))

    # 空白制御を適用する
    for i, t in enumerate(toks):
        if t.kind == "text":
            continue
        if t.lstrip and i > 0 and toks[i - 1].kind == "text":
            toks[i - 1].value = toks[i - 1].value.rstrip()
        if t.rstrip and i + 1 < len(toks) and toks[i + 1].kind == "text":
            toks[i + 1].value = toks[i + 1].value.lstrip()
    return toks


# ---------------------------------------------------------------- 構文解析

class Node:
    pass


class Text(Node):
    def __init__(self, s):
        self.s = s


class Var(Node):
    def __init__(self, expr):
        self.expr = expr


class If(Node):
    def __init__(self):
        self.branches = []   # [(condition_or_None, [nodes]), ...]


class For(Node):
    def __init__(self, var, expr, body):
        self.var, self.expr, self.body = var, expr, body


class Assign(Node):
    def __init__(self, name, expr):
        self.name, self.expr = name, expr


class Include(Node):
    def __init__(self, name, params):
        self.name, self.params = name, params


BLOCK_END = {"endif", "endunless", "endfor", "endcomment", "endraw"}


def parse(toks, i=0, stop=None):
    """stop に列挙されたタグ名に当たるまでパースする。(nodes, next_i, hit) を返す。"""
    nodes = []
    while i < len(toks):
        t = toks[i]
        if t.kind == "text":
            nodes.append(Text(t.value))
            i += 1
        elif t.kind == "var":
            nodes.append(Var(t.value))
            i += 1
        else:
            name = t.value.split()[0] if t.value.split() else ""
            if stop and name in stop:
                return nodes, i, name
            i = _parse_tag(toks, i, nodes)
    if stop:
        raise LiquidError(f"ブロックが閉じられていません (期待: {stop})")
    return nodes, i, None


def _parse_tag(toks, i, nodes):
    t = toks[i]
    parts = t.value.split(None, 1)
    name = parts[0]
    rest = parts[1].strip() if len(parts) > 1 else ""

    if name == "comment":
        _, i, _ = parse(toks, i + 1, {"endcomment"})
        return i + 1

    if name == "raw":
        # raw の中身はそのまま出す
        j = i + 1
        buf = []
        while j < len(toks):
            if toks[j].kind == "tag" and toks[j].value.strip() == "endraw":
                break
            buf.append(toks[j].value if toks[j].kind == "text"
                       else ("{{" + toks[j].value + "}}" if toks[j].kind == "var"
                             else "{%" + toks[j].value + "%}"))
            j += 1
        nodes.append(Text("".join(buf)))
        return j + 1

    if name in ("if", "unless"):
        node = If()
        cond = rest if name == "if" else f"__not__({rest})"
        body, i, hit = parse(toks, i + 1, {"elsif", "else", "endif", "endunless"})
        node.branches.append((cond, body))
        while hit in ("elsif", "else"):
            hparts = toks[i].value.split(None, 1)
            # else は無条件分岐、elsif は条件付き
            hcond = None if hparts[0] == "else" else hparts[1].strip()
            body, i, hit = parse(toks, i + 1, {"elsif", "else", "endif", "endunless"})
            node.branches.append((hcond, body))
        nodes.append(node)
        return i + 1

    if name == "for":
        m = re.match(r"(\w+)\s+in\s+(.+)$", rest)
        if not m:
            raise LiquidError(f"for 構文が不正: {rest}")
        body, i, _ = parse(toks, i + 1, {"endfor"})
        nodes.append(For(m.group(1), m.group(2).strip(), body))
        return i + 1

    if name == "assign":
        m = re.match(r"(\w+)\s*=\s*(.+)$", rest)
        if not m:
            raise LiquidError(f"assign 構文が不正: {rest}")
        nodes.append(Assign(m.group(1), m.group(2).strip()))
        return i + 1

    if name == "include":
        m = re.match(r"([\w.\-/]+)\s*(.*)$", rest, re.DOTALL)
        if not m:
            raise LiquidError(f"include 構文が不正: {rest}")
        params = {}
        for pm in re.finditer(r"(\w+)\s*=\s*("
                              r"\"[^\"]*\"|'[^']*'|[^\s]+)", m.group(2)):
            params[pm.group(1)] = pm.group(2)
        nodes.append(Include(m.group(1), params))
        return i + 1

    raise LiquidError(f"未対応のタグ: {{% {t.value} %}}")


# ---------------------------------------------------------------- 評価

class Undefined:
    """Liquid の nil 相当。偽値で、文字列化すると空。"""
    def __bool__(self):
        return False

    def __str__(self):
        return ""

    def __eq__(self, other):
        return isinstance(other, Undefined) or other is None

    def __hash__(self):
        return 0


NIL = Undefined()


def truthy(v):
    """Liquid の真偽判定: false と nil のみ偽。空文字も 0 も真。"""
    if v is None or isinstance(v, Undefined):
        return False
    if v is False:
        return False
    return True


def lookup(ctx, path):
    cur = ctx
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part, NIL)
        elif hasattr(cur, part):
            cur = getattr(cur, part)
        elif isinstance(cur, (list, tuple)) and part in ("size", "first", "last"):
            cur = {"size": len(cur),
                   "first": cur[0] if cur else NIL,
                   "last": cur[-1] if cur else NIL}[part]
        elif isinstance(cur, str) and part == "size":
            cur = len(cur)
        else:
            return NIL
        if isinstance(cur, Undefined):
            return NIL
    return cur


LITERAL_RE = re.compile(r"^(\".*\"|'.*'|-?\d+\.?\d*|true|false|nil|empty)$", re.DOTALL)


def eval_atom(ctx, s):
    s = s.strip()
    if not s:
        return NIL
    if s.startswith('"') and s.endswith('"') and len(s) >= 2:
        return s[1:-1]
    if s.startswith("'") and s.endswith("'") and len(s) >= 2:
        return s[1:-1]
    if s == "true":
        return True
    if s == "false":
        return False
    if s in ("nil", "null"):
        return NIL
    if s == "empty":
        return ""
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    if re.fullmatch(r"-?\d+\.\d+", s):
        return float(s)
    return lookup(ctx, s)


def split_filters(expr):
    """フィルタチェーンを | で分割する。引用符内の | は無視。"""
    parts, buf, quote, depth = [], [], None, 0
    for ch in expr:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "|" and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return [p.strip() for p in parts]


def split_args(s):
    parts, buf, quote = [], [], None
    for ch in s:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch == ",":
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if "".join(buf).strip():
        parts.append("".join(buf))
    return [p.strip() for p in parts]


def to_s(v):
    if v is None or isinstance(v, Undefined):
        return ""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, list):
        return "".join(to_s(x) for x in v)
    return str(v)


def f_escape(v, *_):
    s = to_s(v)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&#39;"))


def f_where(v, key, val):
    if not isinstance(v, list):
        return []
    out = []
    for item in v:
        got = item.get(key, NIL) if isinstance(item, dict) else getattr(item, key, NIL)
        if to_s(got) == to_s(val):
            out.append(item)
    return out


def f_map(v, key):
    if not isinstance(v, list):
        return []
    out = []
    for item in v:
        got = item.get(key, NIL) if isinstance(item, dict) else getattr(item, key, NIL)
        out.append(got)
    return out


def f_sort(v, key=None):
    if not isinstance(v, list):
        return v
    if key is None:
        return sorted(v, key=lambda x: to_s(x))

    def sk(item):
        got = item.get(key, NIL) if isinstance(item, dict) else getattr(item, key, NIL)
        if isinstance(got, Undefined):
            return (1, 0, "")
        if isinstance(got, (int, float)):
            return (0, got, "")
        return (0, 0, to_s(got))
    return sorted(v, key=sk)


def f_join(v, sep=""):
    if isinstance(v, list):
        return to_s(sep).join(to_s(x) for x in v)
    return to_s(v)


def f_uniq(v, *_):
    if not isinstance(v, list):
        return v
    seen, out = set(), []
    for x in v:
        k = to_s(x)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def f_default(v, d=""):
    # Liquid の default は false/nil/空文字 で発動する
    if v is None or isinstance(v, Undefined) or v is False or v == "":
        return d
    if isinstance(v, list) and not v:
        return d
    return v


def _ruby_split(s, sep):
    parts = s.split(sep) if sep else list(s)
    while parts and parts[-1] == "":
        parts.pop()
    return parts


def f_size(v, *_):
    if isinstance(v, (list, dict, str)):
        return len(v)
    return 0


FILTERS = {
    "escape": f_escape,
    "xml_escape": f_escape,
    "where": f_where,
    "map": f_map,
    "sort": f_sort,
    "join": f_join,
    "uniq": f_uniq,
    "default": f_default,
    "size": f_size,
    "jsonify": lambda v, *_: json.dumps(v, ensure_ascii=False),
    "append": lambda v, s="": to_s(v) + to_s(s),
    "prepend": lambda v, s="": to_s(s) + to_s(v),
    "strip": lambda v, *_: to_s(v).strip(),
    "lstrip": lambda v, *_: to_s(v).lstrip(),
    "rstrip": lambda v, *_: to_s(v).rstrip(),
    "strip_newlines": lambda v, *_: to_s(v).replace("\n", "").replace("\r", ""),
    "downcase": lambda v, *_: to_s(v).lower(),
    "upcase": lambda v, *_: to_s(v).upper(),
    "reverse": lambda v, *_: list(reversed(v)) if isinstance(v, list) else to_s(v)[::-1],
    "first": lambda v, *_: (v[0] if v else NIL) if isinstance(v, list) else NIL,
    "last": lambda v, *_: (v[-1] if v else NIL) if isinstance(v, list) else NIL,
    # Ruby の String#split は末尾の空要素を落とす。Jekyll と挙動を合わせる。
    "split": lambda v, s=",": _ruby_split(to_s(v), to_s(s)),
    "replace": lambda v, a="", b="": to_s(v).replace(to_s(a), to_s(b)),
    "remove": lambda v, a="": to_s(v).replace(to_s(a), ""),
    "slice": lambda v, a=0, b=1: to_s(v)[int(a):int(a) + int(b)],
    "truncate": lambda v, n=50, e="...": (to_s(v) if len(to_s(v)) <= int(n)
                                          else to_s(v)[:int(n) - len(e)] + e),
    "number_of_words": lambda v, *_: len(to_s(v).split()),
    "relative_url": lambda v, *_: to_s(v),
    "absolute_url": lambda v, *_: to_s(v),
}


def evaluate(ctx, expr):
    chain = split_filters(expr)
    val = eval_condition(ctx, chain[0]) if _is_condition(chain[0]) else eval_atom(ctx, chain[0])
    for f in chain[1:]:
        if ":" in f:
            fname, argstr = f.split(":", 1)
            args = [eval_atom(ctx, a) for a in split_args(argstr)]
        else:
            fname, args = f, []
        fname = fname.strip()
        if fname not in FILTERS:
            raise LiquidError(f"未対応のフィルタ: {fname}")
        val = FILTERS[fname](val, *args)
    return val


COND_OPS = re.compile(r"\s+(==|!=|<=|>=|<|>|contains)\s+")


def _is_condition(s):
    return bool(COND_OPS.search(s)) or " and " in s or " or " in s or s.startswith("__not__(")


def eval_condition(ctx, expr):
    expr = expr.strip()
    if expr.startswith("__not__(") and expr.endswith(")"):
        return not truthy(eval_condition(ctx, expr[8:-1]))
    # or は and より弱い
    for op, fn in ((" or ", any), (" and ", all)):
        depth = 0
        quote = None
        idx = []
        i = 0
        while i < len(expr):
            ch = expr[i]
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif depth == 0 and expr[i:i + len(op)] == op:
                idx.append(i)
                i += len(op) - 1
            i += 1
        if idx:
            pieces, prev = [], 0
            for p in idx:
                pieces.append(expr[prev:p])
                prev = p + len(op)
            pieces.append(expr[prev:])
            return fn(truthy(eval_condition(ctx, p)) for p in pieces)

    m = COND_OPS.search(expr)
    if not m:
        return evaluate(ctx, expr)
    left = evaluate(ctx, expr[:m.start()])
    right = evaluate(ctx, expr[m.end():])
    op = m.group(1)
    if op == "==":
        return _eq(left, right)
    if op == "!=":
        return not _eq(left, right)
    if op == "contains":
        if isinstance(left, list):
            return any(_eq(x, right) for x in left)
        return to_s(right) in to_s(left)
    try:
        l, r = float(left), float(right)
    except (TypeError, ValueError):
        return False
    return {"<": l < r, ">": l > r, "<=": l <= r, ">=": l >= r}[op]


def _eq(a, b):
    if isinstance(a, Undefined) or isinstance(b, Undefined):
        return (isinstance(a, Undefined) or a is None) and (isinstance(b, Undefined) or b is None)
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return to_s(a) == to_s(b)


# ---------------------------------------------------------------- 描画

class Template:
    def __init__(self, src, name="<template>", loader=None):
        self.name = name
        self.loader = loader
        self.nodes, _, _ = parse(tokenize(src))

    def render(self, ctx):
        return self._render(self.nodes, ctx)

    def _render(self, nodes, ctx):
        out = []
        for n in nodes:
            if isinstance(n, Text):
                out.append(n.s)
            elif isinstance(n, Var):
                out.append(to_s(evaluate(ctx, n.expr)))
            elif isinstance(n, Assign):
                ctx[n.name] = evaluate(ctx, n.expr)
            elif isinstance(n, If):
                for cond, body in n.branches:
                    if cond is None or truthy(eval_condition(ctx, cond)):
                        out.append(self._render(body, ctx))
                        break
            elif isinstance(n, For):
                seq = evaluate(ctx, n.expr)
                if not isinstance(seq, list):
                    seq = [] if not truthy(seq) else list(seq)
                saved = ctx.get(n.var, NIL)
                for idx, item in enumerate(seq):
                    ctx[n.var] = item
                    ctx["forloop"] = {"index": idx + 1, "index0": idx,
                                      "first": idx == 0, "last": idx == len(seq) - 1,
                                      "length": len(seq)}
                    out.append(self._render(n.body, ctx))
                ctx[n.var] = saved
            elif isinstance(n, Include):
                if self.loader is None:
                    raise LiquidError("include を使うには loader が必要です")
                sub = self.loader(n.name)
                params = {k: evaluate(ctx, v) for k, v in n.params.items()}
                child = dict(ctx)
                child["include"] = params
                out.append(sub.render(child))
        return "".join(out)
