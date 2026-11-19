#!/usr/bin/env python3
import json
import os
import sys

for line in sys.stdin:
    command = json.loads(line)
    kind = command["type"]
    data = command.get("probe", {})
    if kind == "get_available_models":
        data = {"models": [{"provider": "fixture", "id": "naming"}]}
    elif kind == "set_model":
        data = {"provider": command["provider"], "id": command["modelId"]}
    if command.get("id") == "fixture-shutdown":
        with open("fixture-pi.pid", "w") as marker:
            marker.write(str(os.getpid()))
    print(json.dumps({
        "type": "response",
        "id": command.get("id"),
        "command": kind,
        "success": True,
        "data": data,
    }), flush=True)
    if kind == "prompt" and not command.get("id"):
        message = {
            "role": "assistant",
            "content": [{"type": "text", "text": '"' + command["message"] + '"\nignored'}],
            "stopReason": "stop",
        }
        print(json.dumps({"type": "message_end", "message": message}), flush=True)
        print(json.dumps({"type": "agent_settled"}), flush=True)
