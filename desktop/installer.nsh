!macro customInstall
  FileOpen $0 "$INSTDIR\resources\hub-nsis-install" w
  FileWrite $0 "local.aiprojecthub.desktop"
  FileClose $0
!macroend
