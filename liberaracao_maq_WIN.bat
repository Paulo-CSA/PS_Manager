@echo off
echo ==== FIX COMPLETO PsExec ====

:: 1. Garantir usuario admin ativo e com senha
net user admin admin /active:yes

:: 2. Colocar no grupo Administradores
net localgroup Administrators admin /add

:: 3. Liberar UAC remoto
reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f

:: 4. Habilitar compartilhamentos administrativos
reg add HKLM\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters /v AutoShareWks /t REG_DWORD /d 1 /f

:: 5. Iniciar serviços essenciais
sc config LanmanServer start= auto
sc start LanmanServer

sc config LanmanWorkstation start= auto
sc start LanmanWorkstation

sc config RemoteRegistry start= auto
sc start RemoteRegistry

:: 6. Firewall OFF (teste)
netsh advfirewall set allprofiles state off

:: 7. Criar politica de seguranca completa
echo [Unicode] > %temp%\psexec_full.inf
echo Unicode=yes >> %temp%\psexec_full.inf
echo [Version] >> %temp%\psexec_full.inf
echo signature="$CHICAGO$" >> %temp%\psexec_full.inf
echo Revision=1 >> %temp%\psexec_full.inf
echo [Privilege Rights] >> %temp%\psexec_full.inf

:: Permissoes importantes
echo SeBatchLogonRight = *S-1-5-32-544 >> %temp%\psexec_full.inf
echo SeServiceLogonRight = *S-1-5-32-544 >> %temp%\psexec_full.inf
echo SeNetworkLogonRight = *S-1-5-32-544 >> %temp%\psexec_full.inf

:: Limpar negacoes
echo SeDenyBatchLogonRight = >> %temp%\psexec_full.inf
echo SeDenyNetworkLogonRight = >> %temp%\psexec_full.inf
echo SeDenyServiceLogonRight = >> %temp%\psexec_full.inf

:: Aplicar politica
secedit /configure /db %temp%\psexec_full.sdb /cfg %temp%\psexec_full.inf /areas USER_RIGHTS

:: 8. Atualizar politicas
gpupdate /force

echo ==== FINALIZADO ====
echo Reinicie o computador antes de testar!
pause