' Starts the Evidence demo server with no visible window.
' Used by the "EvidenceDemoServer" scheduled task (runs at logon).
CreateObject("WScript.Shell").Run """D:\Downloads\node.exe"" ""D:\Claude\New Ideas\Demo_Evidence Detection\server.mjs""", 0, False
