Node.js

1. diretorio de execução dos psexec (c:\windows\system32)

2. maquinas win com liberação (reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f)

3. Install dependencies: npm install

4. Instalar o GIT

5. Instalar o node 

6. npm install -g pm2
7. npm install (dentro da pasta do projeto)

0. INICIAR
Run the app: start /B npm run dev

01. FECHAR
netstat -ano | findstr :3000

tasklist | findstr 1234


