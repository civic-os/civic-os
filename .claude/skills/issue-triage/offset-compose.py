# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compose override for the issue-triage skill's own example stack.

Reads `docker compose config --format json` on stdin and prints an override that
renames every container (triage_ prefix) and moves every published port up by
OFFSET (default 10000), so the stack runs beside one started from the examples
as-is. `!override` replaces each ports list instead of appending to it.

    docker compose config --format json | python3 -I offset-compose.py [OFFSET] > override.yml
"""
import json
import sys

offset = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
config = json.load(sys.stdin)
lines = ["services:"]
for name, service in config["services"].items():
    lines.append("  %s:" % name)
    if service.get("container_name"):
        lines.append("    container_name: triage_%s" % service["container_name"])
    if service.get("ports"):
        lines.append("    ports: !override")
        for port in service["ports"]:
            lines.append('      - "%d:%s"' % (int(port["published"]) + offset, port["target"]))
print("\n".join(lines))
