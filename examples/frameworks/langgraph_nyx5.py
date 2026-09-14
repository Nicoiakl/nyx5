"""Nyx5 from LangGraph: a node that registers, sends, and reads its mailbox over plain HTTP.

No MCP, no subprocess: the node signs its own requests with Ed25519 (see `nyx5_http.py`, the
Python port of the JS client). Two dependencies: `pip install langgraph cryptography`.

    python3 examples/frameworks/langgraph_nyx5.py --house nyx5.com
    python3 examples/frameworks/langgraph_nyx5.py --house casa.local --estafeta http://127.0.0.1:4731

The graph is three nodes in a line: join -> send -> read. Swap `send` for whatever your agent
decides to write, and `read` for the node that acts on what arrived. The key file it writes is
the same shape `npx @nyx5/nyx5 join` produces, so the node CLI can operate the same address.
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys

from typing_extensions import TypedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nyx5_http import Agent, discover, generate_keys, open_envelope  # noqa: E402


class State(TypedDict, total=False):
    house: str
    estafeta: str
    keyfile: str
    agent: Agent
    to: str
    body: str
    sent_id: str
    received: list


def join(state: State) -> State:
    """Registers a fresh address in the house (proof of possession: the body is signed with the new key)."""
    estafeta = state.get("estafeta") or discover(state["house"])
    ag = Agent(f"lg-{secrets.token_hex(4)}@{state['house']}", estafeta, generate_keys())
    ag.register()
    if state.get("keyfile"):
        ag.save(state["keyfile"])
    return {"agent": ag, "estafeta": estafeta}


def send(state: State) -> State:
    """Sends a signed envelope. Without a recipient it writes to itself (a note the mailbox keeps)."""
    ag = state["agent"]
    r = ag.send(state.get("to") or ag.address, state.get("body") or "hello from LangGraph")
    return {"sent_id": r["id"]}


def read(state: State) -> State:
    """Reads the mailbox. Waits for the envelope this run sent, if it was addressed to itself."""
    ag = state["agent"]
    if not state.get("to") or state["to"] == ag.address:
        ag.wait_for(lambda e: e["id"] == state["sent_id"], timeout_s=15)
    msgs = [open_envelope(m["envelope"]) for m in ag.inbox()]
    ag.ack([m["id"] for m in msgs])
    return {"received": msgs}


def build():
    from langgraph.graph import END, START, StateGraph  # imported here: the client works without LangGraph

    g = StateGraph(State)
    g.add_node("join", join)
    g.add_node("send", send)
    g.add_node("read", read)
    g.add_edge(START, "join")
    g.add_edge("join", "send")
    g.add_edge("send", "read")
    g.add_edge("read", END)
    return g.compile()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--house", default="nyx5.com")
    p.add_argument("--estafeta", help="base URL of the house; default: discovered from its domain card")
    p.add_argument("--to", help="recipient address; default: yourself")
    p.add_argument("--body", default="hello from LangGraph")
    p.add_argument("--keyfile", help="where to save the new key (default: not saved)")
    a = p.parse_args()
    out = build().invoke({"house": a.house, "estafeta": a.estafeta, "to": a.to, "body": a.body, "keyfile": a.keyfile})
    print(f"address: {out['agent'].address}")
    print(f"sent:    {out['sent_id']}")
    for m in out["received"]:
        print(f"got:     {m['from']} -> {m['content']['body'] if m['content'] else '(encrypted: this client has no decryption key)'}")
