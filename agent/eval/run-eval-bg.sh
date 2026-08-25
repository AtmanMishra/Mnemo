#!/bin/bash
cd /Users/srutinayak/self-evolving-agent/agent
# secrets come from gitignored .env - never hardcode keys here
set -a; source ../memory-layer/.env; set +a
export SEA_PROVIDER=opencode-go
export SEA_MODEL=ox-alpha-free
node eval/memory-eval.mjs > /tmp/sea-eval-result.txt 2>/tmp/sea-eval-progress.log
echo "DONE exit=$?" >> /tmp/sea-eval-progress.log
