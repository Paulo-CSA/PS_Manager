@echo off
echo ==== FIX COMPLETO PsExec ====

reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f

netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes

netsh advfirewall set allprofiles state off

reg add HKLM\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters /v AutoShareWks /t REG_DWORD /d 1 /f

sc config LanmanServer start= auto
sc start LanmanServer

sc config LanmanWorkstation start= auto
sc start LanmanWorkstation

sc config RemoteRegistry start= auto
sc start RemoteRegistry

