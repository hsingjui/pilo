#!/usr/bin/env python3
import json
import sys

for line in sys.stdin:
    command = json.loads(line)
    print(json.dumps({
        "type": "response",
        "id": command.get("id"),
        "command": command["type"],
        "success": True,
        "data": {},
    }), flush=True)
