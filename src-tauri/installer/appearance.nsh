; use tauri's normal install and update flow, with a short welcome animation.
!include nsDialogs.nsh
!include LogicLib.nsh

!define MUI_HEADERIMAGE_RIGHT
!define MUI_BGCOLOR "FFF9FD"
!define MUI_TEXTCOLOR "372A4E"
!define MUI_WELCOMEPAGE_TITLE "Welcome to Kawaicord"
!define MUI_WELCOMEPAGE_TEXT "A little more kawaii on your desktop.$\r$\n$\r$\nChoose where to install Kawaicord on the next screen."
!define MUI_FINISHPAGE_TITLE "Kawaicord is ready!"
!define MUI_FINISHPAGE_TEXT "Pick your shortcuts and finish setup."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KawaiiWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_DESTROYED KawaiiWelcomeDestroyed

Var KawaiiArt
Var KawaiiBitmap
Var KawaiiOldBitmap
Var KawaiiFrame

Function KawaiiWelcomeShow
  StrCpy $KawaiiArt 0
  StrCpy $KawaiiBitmap 0
  Push $0
  Push $1
  ; respect the windows animation preference. keep the still image if unavailable.
  System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i .r0, i 0)i.r1'
  ${If} $0 != 0
  ${AndIf} $1 != 0
    InitPluginsDir
    File "/oname=$PLUGINSDIR\kawaicord-blink.bmp" "${__FILEDIR__}\blink.bmp"
    File "/oname=$PLUGINSDIR\kawaicord-sparkle.bmp" "${__FILEDIR__}\sparkle.bmp"
    ${NSD_CreateBitmap} 0u 0u 109u 193u ""
    Pop $KawaiiArt
    ${NSD_SetStretchedImage} $KawaiiArt "$PLUGINSDIR\modern-wizard.bmp" $KawaiiBitmap
    StrCpy $KawaiiFrame 0
    ${NSD_CreateTimer} KawaiiWelcomeTick 280
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function KawaiiWelcomeTick
  IntOp $KawaiiFrame $KawaiiFrame + 1
  StrCpy $KawaiiOldBitmap $KawaiiBitmap
  ${Select} $KawaiiFrame
    ${Case} 1
    ${Case} 3
      ${NSD_SetStretchedImage} $KawaiiArt "$PLUGINSDIR\kawaicord-sparkle.bmp" $KawaiiBitmap
    ${Case} 2
      ${NSD_SetStretchedImage} $KawaiiArt "$PLUGINSDIR\kawaicord-blink.bmp" $KawaiiBitmap
    ${Default}
      ${NSD_SetStretchedImage} $KawaiiArt "$PLUGINSDIR\modern-wizard.bmp" $KawaiiBitmap
      ${NSD_KillTimer} KawaiiWelcomeTick
  ${EndSelect}
  ${NSD_FreeBitmap} $KawaiiOldBitmap
FunctionEnd

Function KawaiiWelcomeDestroyed
  ${If} $KawaiiArt != 0
    ${NSD_KillTimer} KawaiiWelcomeTick
    ${NSD_FreeBitmap} $KawaiiBitmap
  ${EndIf}
FunctionEnd
