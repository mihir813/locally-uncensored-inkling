Locally Uncensored - portable folder (Windows 10/11, 64-bit)
=============================================================

Start:  double-click  locally-uncensored.exe  in this folder.
Nothing is installed. Keep all files of this folder together: the program
looks for its engine (lu-llama-server.exe and the DLLs) next to itself.

What "portable" means here
- No installer, no Start menu entry, no uninstaller. To remove it, delete the folder.
- Your chats, settings and models are stored where the installed app stores
  them, in your Windows user profile (%APPDATA% and %LOCALAPPDATA%,
  com.purpledoubled.locally-uncensored). The folder itself stays unchanged, so
  the installed app and this folder share the same data.
- The app needs Microsoft Edge WebView2, which is part of Windows 11.

Models
- No model is included. Use "Import GGUF" in the model list to pick a .gguf
  file from your disk, for example Inkling-2-Mini-Uncensored-IQ4_NL.gguf.

The program is not code signed. Windows SmartScreen may ask once:
"More info", then "Run anyway".

Source and licence (AGPL-3.0): see the release page this ZIP came from.
