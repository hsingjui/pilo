#!/usr/bin/env python3
import json
import os
import sys


def widget(key, lines):
    print(json.dumps({
        "type": "extension_ui_request",
        "id": key,
        "method": "setWidget",
        "widgetKey": key,
        "widgetLines": lines,
    }), flush=True)


enhancement = any("You rewrite a user's draft prompt" in arg for arg in sys.argv)
selected_model = None


for line in sys.stdin:
    command = json.loads(line)
    kind = command["type"]
    prediction = kind == "prompt" and command["message"].startswith("/pilo-next-prompt ")
    data = command.get("probe", {})
    if kind == "get_available_models":
        data = {"models": [{
            "provider": "fixture",
            "id": "naming",
            "name": "Naming Model",
            "reasoning": False,
        }]}
        if enhancement:
            data["models"].extend(
                {"provider": "fixture", "id": model} for model in ("rewrite", "chat")
            )
    elif kind == "set_model":
        selected_model = command["modelId"]
        data = {"provider": command["provider"], "id": command["modelId"]}
    elif prediction:
        data = json.loads(command["message"].split(" ", 1)[1])
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
    if kind == "get_state" and command.get("id") == "fixture-next-prompt-ready":
        widget("pilo.next-prompt.ready.v1", ["ready"])
    if prediction and not data["cancel"]:
        result = {
            key: data[key] for key in ("requestId", "sessionId", "revision")
        }
        result.update(leafId="fixture-leaf", text="What comes next?", status="ready")
        widget("pilo.next-prompt.v1", [json.dumps(result)])
    if kind == "prompt" and command.get("id") == "fixture-transcript-turn":
        for event in (
            {"type": "agent_start"},
            {"type": "message_start", "message": {
                "role": "user", "content": [{"type": "text", "text": command["message"]}],
            }},
            {"type": "message_start", "message": {"role": "assistant"}},
            {"type": "message_update", "assistantMessageEvent": {
                "type": "text_delta", "delta": "partial reply",
            }},
        ):
            print(json.dumps(event), flush=True)
    if kind == "prompt" and not command.get("id"):
        reply = '"' + command["message"] + '"\nignored'
        stop_reason = "stop"
        error_message = None
        if enhancement:
            if not {"--no-session", "--no-tools", "--no-extensions"}.issubset(sys.argv):
                stop_reason, error_message = "error", "enhancement must not load a session or resources"
            elif command["message"] == "fail generation":
                stop_reason, error_message = "error", "fixture generation failed"
            elif command["message"] == "empty rewrite":
                reply = '" "'
            else:
                reply = f'```text\n"{selected_model}: {command["message"]}"\n```'
        message = {
            "role": "assistant",
            "content": [{"type": "text", "text": reply}],
            "stopReason": stop_reason,
        }
        if error_message is not None:
            message["errorMessage"] = error_message
        print(json.dumps({"type": "message_end", "message": message}), flush=True)
        print(json.dumps({"type": "agent_settled"}), flush=True)
