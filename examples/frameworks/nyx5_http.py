"""Nyx5 from Python, by plain HTTP. The three calls an agent needs: register, send, read.

This is the Python reproduction of what `src/correo/agente.js` does in JavaScript:

  * JSON canonical form (sorted keys, no spaces)         -> `canonical()`
  * Ed25519 signature over an object                     -> `sign_object()`
  * the `Authorization: Nyx5 <token>.<signature>` header -> `auth_header()`

Dependency: `pip install cryptography` (Ed25519). Nothing else; stdlib for HTTP and JSON.

What this client does NOT do, on purpose:
  * It does not publish an encryption key. Mail to this agent therefore arrives SIGNED but
    IN THE CLEAR (senders that require encryption refuse). To read encrypted mail you need
    X25519 + HKDF + AES-GCM (see `src/nucleo/crypto.js`), which is out of scope here.
  * It does not send encrypted mail: `send()` writes `content` in the clear.
  * It does not touch the ledger (quotes, escrow, mandates). Same auth, other routes; see SPEC.

Wire format notes that matter for the signature (they are where a port breaks):
  * `canonical()` must produce byte-identical output to the JS `canonical()`. Integers,
    strings, booleans, null, lists and dicts are covered; floats are REFUSED (JS prints 1.0
    as "1", Python as "1.0": signing a float here would verify nowhere).
  * `sig` and `sigPriv` are the JWK `x` and `d` of the Ed25519 key: base64url, no padding.
  * The auth token is bound to method, path (without query string) and the HOUSE host.

Usage (CLI, see `--help`):
  python3 nyx5_http.py register --estafeta http://127.0.0.1:4731 --house casa.local --out me.json
  python3 nyx5_http.py send  --agent me.json --to someone@casa.local --body "hello"
  python3 nyx5_http.py inbox --agent me.json [--ack]
  python3 nyx5_http.py demo  --estafeta http://127.0.0.1:4731 --house casa.local
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
except ImportError as e:  # pragma: no cover
    raise SystemExit("this example needs `pip install cryptography` (Ed25519)") from e


# ---------- canonical JSON: must match src/nucleo/crypto.js canonical() byte for byte ----------
def canonical(value) -> str:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # Fail closed: JS and Python print floats differently (1.0 vs 1). A float that slips
        # into a signed object produces a signature the house cannot verify. Nyx5 objects
        # carry no floats; if yours does, encode it as a string on both sides.
        raise TypeError("canonical(): floats are not portable between JS and Python; use int or str")
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        # JS sorts keys by UTF-16 code unit; Python by code point. Identical for keys inside
        # the Basic Multilingual Plane, which is every key Nyx5 uses.
        keys = sorted(k for k, v in value.items() if v is not _OMIT)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False, separators=(",", ":")) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(f"canonical(): unsupported type {type(value).__name__}")


_OMIT = object()  # stands in for JS `undefined`: the key is dropped, unlike `None` (JSON null)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def iso_now() -> str:
    # Same shape as JS Date.toISOString(): millisecond precision, trailing Z.
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


# ---------- keys and signatures ----------
def generate_keys() -> dict:
    priv = Ed25519PrivateKey.generate()
    return {"sig": b64u(priv.public_key().public_bytes_raw()), "sigPriv": b64u(priv.private_bytes_raw())}


def _private(keys: dict) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(unb64u(keys["sigPriv"]))


def sign_bytes(data: bytes, keys: dict) -> str:
    return b64u(_private(keys).sign(data))


def sign_object(obj: dict, keys: dict) -> dict:
    """Signs every field except `signature`, exactly like JS signObject()."""
    body = {k: v for k, v in obj.items() if k != "signature"}
    value = sign_bytes(canonical(body).encode(), keys)
    return {**body, "signature": {"alg": "Ed25519", "kid": keys["sig"], "value": value}}


def auth_header(address: str, keys: dict, method: str, path: str, estafeta: str) -> str:
    """`Authorization: Nyx5 <token>.<signature>` (SPEC section 8). `path` carries no query string."""
    host = estafeta.split("://", 1)[1].split("/", 1)[0]
    claims = {"address": address, "ts": iso_now(), "nonce": str(uuid.uuid4()), "method": method, "path": path, "host": host}
    raw = canonical(claims)
    return f"Nyx5 {b64u(raw.encode())}.{sign_bytes(raw.encode(), keys)}"


# ---------- HTTP ----------
class Nyx5Error(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"HTTP {status}: {body.get('reason', body)}")
        self.status, self.body = status, body


USER_AGENT = "nyx5-http-python/1"


def _request(method: str, url: str, body=None, headers=None, timeout=10) -> dict:
    data = None if body is None else json.dumps(body).encode()
    # The User-Agent is explicit on purpose: nyx5.com sits behind Cloudflare, which answers 403
    # to urllib's default `Python-urllib/x.y` before the request reaches the house (measured
    # 2026-09-14). A local house does not care; the public one does.
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", "user-agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b"{}")
        except ValueError:
            payload = {}
        raise Nyx5Error(e.code, payload) from None


def discover(house: str) -> str:
    """Where a house lives: its domain card at https://<house>/.well-known/nyx5.json (SPEC section 2)."""
    return _request("GET", f"https://{house}/.well-known/nyx5.json")["estafeta"].rstrip("/")


class Agent:
    def __init__(self, address: str, estafeta: str, keys: dict):
        self.address, self.estafeta, self.keys = address, estafeta.rstrip("/"), keys
        self.local, self.domain = address.split("@", 1)

    # -- persistence: same file shape as `nyx5 join` writes, so the node CLI can load it too --
    @classmethod
    def load(cls, file: str) -> "Agent":
        with open(file) as f:
            j = json.load(f)
        return cls(j["address"], j["estafeta"], j["keys"])

    def save(self, file: str) -> None:
        with open(file, "w", opener=lambda p, f: os.open(p, f, 0o600)) as f:
            json.dump({"address": self.address, "estafeta": self.estafeta, "keys": self.keys}, f, indent=2)

    def _call(self, method: str, path: str, body=None, auth=True) -> dict:
        headers = {"authorization": auth_header(self.address, self.keys, method, path.split("?")[0], self.estafeta)} if auth else {}
        return _request(method, f"{self.estafeta}{path}", body, headers)

    # -- 1. register: proof of possession (the body is signed with the key being enrolled) --
    def register(self, listed: bool = False, invite: str | None = None) -> dict:
        body = {"local": self.local, "sig": self.keys["sig"], "capabilities": {"listed": listed}, "ts": iso_now()}
        if invite:
            body["invite"] = invite
        self.card = self._call("POST", "/agents", sign_object(body, self.keys), auth=False)
        return self.card

    # -- 2. send: a signed envelope, content in the clear (this client publishes no enc key) --
    def send(self, to: str | list, body, type: str = "message", media: str | None = None, thread: str | None = None, in_reply_to: str | None = None) -> dict:
        recipients = to if isinstance(to, list) else [to]
        env = {
            "nyx5": "1", "id": str(uuid.uuid4()), "from": self.address, "to": recipients, "created": iso_now(),
            "expires": None, "thread": thread, "in_reply_to": in_reply_to, "type": type,
            "content": {"media": media or ("text/plain" if isinstance(body, str) else "application/json"), "body": body},
        }
        return self._call("POST", "/outbound", sign_object(env, self.keys))

    # -- 3. read: what is waiting in the mailbox; ack what you have processed --
    def inbox(self, limit: int = 50) -> list:
        return self._call("GET", f"/mailbox/{self.local}?limit={limit}")["messages"]

    def ack(self, ids: list) -> list:
        return self._call("POST", f"/mailbox/{self.local}/ack", {"ids": ids})["acked"]

    def wait_for(self, predicate, timeout_s: float = 10, every_s: float = 0.25):
        until = time.time() + timeout_s
        while time.time() < until:
            for m in self.inbox(200):
                if predicate(m["envelope"]):
                    return m
            time.sleep(every_s)
        raise TimeoutError(f"no envelope arrived for {self.address} in {timeout_s}s")


def open_envelope(envelope: dict) -> dict:
    """Reads a plaintext envelope. Encrypted ones are reported as such, never guessed at.
    NOTE: this does not verify the sender signature (that needs the sender card and a resolver);
    the house already refused anything unsigned or badly signed before it reached the mailbox."""
    if "encrypted" in envelope:
        return {"id": envelope["id"], "from": envelope["from"], "type": envelope["type"], "encrypted": True, "content": None}
    return {"id": envelope["id"], "from": envelope["from"], "type": envelope["type"], "encrypted": False, "content": envelope.get("content")}


# ---------- CLI ----------
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register"); r.add_argument("--house", required=True); r.add_argument("--estafeta", help="base URL; default: discover via https://<house>/.well-known/nyx5.json"); r.add_argument("--name"); r.add_argument("--out", required=True); r.add_argument("--invite")
    s = sub.add_parser("send"); s.add_argument("--agent", required=True); s.add_argument("--to", required=True); s.add_argument("--body", required=True)
    i = sub.add_parser("inbox"); i.add_argument("--agent", required=True); i.add_argument("--ack", action="store_true")
    d = sub.add_parser("demo", help="register, write to yourself, read it back"); d.add_argument("--house", required=True); d.add_argument("--estafeta"); d.add_argument("--out")
    a = p.parse_args(argv)

    if a.cmd == "register":
        estafeta = a.estafeta or discover(a.house)
        ag = Agent(f"{a.name or 'py-' + secrets.token_hex(4)}@{a.house}", estafeta, generate_keys())
        ag.register()
        ag.save(a.out)
        print(json.dumps({"address": ag.address, "keyfile": a.out, "estafeta": estafeta}))
    elif a.cmd == "send":
        ag = Agent.load(a.agent)
        print(json.dumps(ag.send(a.to, a.body)))
    elif a.cmd == "inbox":
        ag = Agent.load(a.agent)
        msgs = ag.inbox()
        out = [open_envelope(m["envelope"]) for m in msgs]
        if a.ack and msgs:
            ag.ack([m["envelope"]["id"] for m in msgs])
        print(json.dumps({"count": len(out), "messages": out}))
    elif a.cmd == "demo":
        estafeta = a.estafeta or discover(a.house)
        ag = Agent(f"py-{secrets.token_hex(4)}@{a.house}", estafeta, generate_keys())
        ag.register()
        if a.out:
            ag.save(a.out)
        sent = ag.send(ag.address, "hello from Python")
        m = ag.wait_for(lambda e: e["id"] == sent["id"])
        opened = open_envelope(m["envelope"])
        ag.ack([opened["id"]])
        print(json.dumps({"address": ag.address, "sent": sent["id"], "received": opened, "keyfile": a.out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
