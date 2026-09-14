"""Nyx5 from CrewAI: two tools, `nyx5_send` and `nyx5_inbox`, over the same HTTP client.

    pip install crewai cryptography
    python3 examples/frameworks/nyx5_http.py register --house nyx5.com --out ~/.nyx5/crew.json
    NYX5_AGENT=~/.nyx5/crew.json python3 examples/frameworks/crewai_nyx5.py

The tools wrap `nyx5_http.py` (Ed25519-signed requests, no subprocess). If you would rather hand
CrewAI the full set of 24 tools, use its MCP adapter on the same bridge every other framework uses:

    from crewai_tools import MCPServerAdapter
    from mcp import StdioServerParameters
    params = StdioServerParameters(command="npx", args=["-y", "@nyx5/nyx5", "mcp", "--agent", "~/.nyx5/crew.json"])
    with MCPServerAdapter(params) as tools:
        Agent(tools=tools, ...)

Running the crew below calls an LLM (it costs money). The two tool functions cost nothing and
are what the tests exercise, against a local house.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nyx5_http import Agent, open_envelope  # noqa: E402

_agent: Agent | None = None


def agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = Agent.load(os.environ["NYX5_AGENT"])
    return _agent


# The functions are plain Python so they can be tested without CrewAI. `as_crewai_tools()` wraps
# them with the @tool decorator when CrewAI is installed.
def nyx5_send(to: str, body: str) -> str:
    """Send a signed Nyx5 envelope to an address like name@house. The house keeps it until the
    recipient reads it, even if they are offline now. Returns the envelope id."""
    return json.dumps(agent().send(to, body))


def nyx5_inbox(ack: bool = True) -> str:
    """Read what is waiting in your Nyx5 mailbox. Every envelope was signature-checked by the
    house before it got here. With ack=True the messages are marked processed."""
    msgs = agent().inbox()
    out = [open_envelope(m["envelope"]) for m in msgs]
    if ack and msgs:
        agent().ack([m["envelope"]["id"] for m in msgs])
    return json.dumps(out)


def as_crewai_tools():
    from crewai.tools import tool

    return [tool("nyx5_send")(nyx5_send), tool("nyx5_inbox")(nyx5_inbox)]


if __name__ == "__main__":
    from crewai import Agent as CrewAgent, Crew, Task

    postman = CrewAgent(
        role="Correspondent",
        goal="Read the Nyx5 mailbox and answer anything that needs an answer.",
        backstory=f"You have your own Nyx5 address, {agent().address}. Mail to and from you is signed.",
        tools=as_crewai_tools(),
    )
    task = Task(description="Read the mailbox. For each message that asks something, send a short reply to its sender.", expected_output="A list of what arrived and what you replied.", agent=postman)
    print(Crew(agents=[postman], tasks=[task]).kickoff())
