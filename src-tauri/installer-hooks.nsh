!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "lepao-poju.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Retire preview registration only when it describes this installation directory.
  ReadRegStr $0 SHCTX "Software\lepaopoju\不道乐跑（开发预览）" ""
  ${If} $0 == $INSTDIR
    !insertmacro IsShortcutTarget "$DESKTOP\不道乐跑（开发预览）.lnk" "$INSTDIR\budao-lepao.exe"
    Pop $1
    ${If} $1 == 0
      !insertmacro IsShortcutTarget "$DESKTOP\不道乐跑（开发预览）.lnk" "$INSTDIR\lepao-poju.exe"
      Pop $1
    ${EndIf}
    ${If} $1 == 1
      Delete "$DESKTOP\不道乐跑（开发预览）.lnk"
      CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\不道乐跑（开发预览）.lnk" "$INSTDIR\budao-lepao.exe"
    Pop $1
    ${If} $1 == 0
      !insertmacro IsShortcutTarget "$SMPROGRAMS\不道乐跑（开发预览）.lnk" "$INSTDIR\lepao-poju.exe"
      Pop $1
    ${EndIf}
    ${If} $1 == 1
      Delete "$SMPROGRAMS\不道乐跑（开发预览）.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\不道乐跑（开发预览）\不道乐跑（开发预览）.lnk" "$INSTDIR\budao-lepao.exe"
    Pop $1
    ${If} $1 == 0
      !insertmacro IsShortcutTarget "$SMPROGRAMS\不道乐跑（开发预览）\不道乐跑（开发预览）.lnk" "$INSTDIR\lepao-poju.exe"
      Pop $1
    ${EndIf}
    ${If} $1 == 1
      Delete "$SMPROGRAMS\不道乐跑（开发预览）\不道乐跑（开发预览）.lnk"
      RMDir "$SMPROGRAMS\不道乐跑（开发预览）"
    ${EndIf}
    Delete "$INSTDIR\lepao-poju.exe"
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\不道乐跑（开发预览）"
    DeleteRegKey SHCTX "Software\lepaopoju\不道乐跑（开发预览）"
  ${EndIf}
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 budao_no_desktop
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  budao_no_desktop:
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 budao_no_startmenu
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  budao_no_startmenu:
  IfFileExists "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" 0 budao_no_nested_menu
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    CreateShortCut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  budao_no_nested_menu:
  Delete "$INSTDIR\budao-icon-0.1.5.ico"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$INSTDIR\uninstall.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; Reuse the stock unchecked "delete application data" checkbox, but never delete old AppData.
Var BudaoDeleteLocalData
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $BudaoDeleteLocalData $DeleteAppDataCheckboxState
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $BudaoDeleteLocalData = 1
  ${AndIf} $UpdateMode <> 1
    GetFullPathName $0 "$INSTDIR\data"
    StrCpy $1 "$INSTDIR\data"
    ${If} $0 == $1
      Push "$INSTDIR\data"
      Call un.BudaoSafeDataTree
      Pop $0
      ${If} $0 == 1
        RMDir /r "$INSTDIR\data"
        RMDir "$INSTDIR"
      ${Else}
        MessageBox MB_ICONEXCLAMATION "数据目录包含链接或无法检查，已保留。请自行检查后删除。"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
; Refuse directory junctions/reparse points anywhere under data before recursive deletion.
Function un.BudaoSafeDataTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $4 1
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
  ${If} $1 = -1
    Goto budao_tree_done
  ${EndIf}
  IntOp $1 $1 & 0x400
  ${If} $1 <> 0
    StrCpy $4 0
    Goto budao_tree_done
  ${EndIf}
  FindFirst $2 $3 "$0\*"
  budao_tree_loop:
    ${If} $3 == ""
      Goto budao_tree_close
    ${EndIf}
    ${If} $3 != "."
    ${AndIf} $3 != ".."
      System::Call 'kernel32::GetFileAttributesW(w "$0\$3") i .r1'
      ${If} $1 = -1
        StrCpy $4 0
        Goto budao_tree_close
      ${EndIf}
      IntOp $1 $1 & 0x400
      ${If} $1 <> 0
        StrCpy $4 0
        Goto budao_tree_close
      ${EndIf}
      IfFileExists "$0\$3\*" 0 budao_tree_next
        Push "$0\$3"
        Call un.BudaoSafeDataTree
        Pop $1
        ${If} $1 == 0
          StrCpy $4 0
          Goto budao_tree_close
        ${EndIf}
    ${EndIf}
    budao_tree_next:
    FindNext $2 $3
    Goto budao_tree_loop
  budao_tree_close:
  FindClose $2
  budao_tree_done:
  StrCpy $0 $4
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd
