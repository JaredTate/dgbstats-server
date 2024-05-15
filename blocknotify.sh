#!/bin/bash

BLOCK_HASH=$1
ENDPOINT="http://localhost:5001/api/blocknotify"

curl -X POST -H "Content-Type: application/json" -d "{\"blockhash\":\"$BLOCK_HASH\"}" $ENDPOINT