; ---------------------------------------------------------------------------
; 文献阅读器 —— 自定义 NSIS 脚本（electron-builder nsis.include）
;
; 解决的问题：
;
; 1) 「文献阅读器 无法关闭。请手动关闭它，然后单击重试以继续。」死循环
;    electron-builder 26.x 默认按「进程路径以 $INSTDIR 开头」判断应用是否在运行，
;    一旦安装目录包含安装器自身（选了 release\0.1.0 或项目根），就会把安装器当成
;    正在运行的应用，而它杀不掉自己 → 永久重试。这里改成按进程名精确匹配。
;
; 2) 安装到一半报「不能打开要写入的文件: <安装目录>\Uninstall 文献阅读器.exe」
;    这个文件是 electron-builder 在复制应用文件那一步用 File /oname 写出来的
;    （templates/nsis/include/installer.nsh 末尾）。只要上一次安装/卸载的
;    卸载器进程还没退干净（进程名 Un_A 或 Uninstall 文献阅读器），文件被占用，
;    File 就写不进去。这里先把这类残留进程关掉，并把旧卸载器删掉/改名。
;
; 覆盖点：customCheckAppRunning —— 安装与卸载流程都会在“动文件之前”插入它。
; ---------------------------------------------------------------------------

!macro customCheckAppRunning
  DetailPrint "关闭正在运行的 ${PRODUCT_NAME}（含开发版 electron.exe 与残留卸载器）…"

  ; 1) 正式版应用：按进程名精确匹配（不带 .exe）
  ;    安装器自身进程名是 文献阅读器-0.1.0-win-x64，与此不匹配，不会被误杀
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process -Name '${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $R0

  ; 2) 残留卸载器：NSIS 卸载器运行时会把自己复制成 Un_A.exe
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process -Name 'Un_A','Uninstall ${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $R0

  ; 3) 开发版实例：electron.exe，但只限可执行文件位于本项目目录下的，
  ;    避免误杀机器上其它 Electron 开发程序
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*paper-reader*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $R0

  Sleep 400

  ; 4) 处理旧的卸载器文件：先去掉只读/隐藏等属性，能删就删，
  ;    删不掉（仍被占用）就改名让路，保证后面 File /oname 能写入
  ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    DetailPrint "清理旧的卸载器文件…"
    SetFileAttributes "$INSTDIR\${UNINSTALL_FILENAME}" NORMAL
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      Rename "$INSTDIR\${UNINSTALL_FILENAME}" "$INSTDIR\${UNINSTALL_FILENAME}.old"
      Delete "$INSTDIR\${UNINSTALL_FILENAME}.old"
      Delete /REBOOTOK "$INSTDIR\${UNINSTALL_FILENAME}.old"
    ${EndIf}
  ${EndIf}
!macroend
