!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define GoatStrRep '${UnStrRep}'
!else
  ${StrRep}
  !define GoatStrRep '${StrRep}'
!endif

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "GOAT_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:GOAT_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'GOAT', 'GOAT (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "GOAT_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "GOAT"
      ${OrIf} $1 == "GOAT (Nightly)"
        ${GoatStrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${GoatStrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${GoatStrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
