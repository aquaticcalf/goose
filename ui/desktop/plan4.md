* we are improving the compaction and summarization ux in this app
* review the diff to date by running: git diff main
* i want to make an improvements now
* right now if I try to compact a conversation twice, it errors the second time because the rust server handling the compaction requests doesn't recognize the compactionMarkers. summarizationRequested messages used to be inserted and used so this needs to be the message content type - not compactionMarker
