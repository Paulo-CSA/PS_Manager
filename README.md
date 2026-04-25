## Run Locally

**Prerequisites:**  Node.js

1. apt install -y pipx 
2. pipx ensurepath 
3. pipx install impacket 

4. diretorio de execução dos psexec (/root/.local/bin/psexec.py -h) 
5. maquinas win com liberação (reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f) 

6. Install dependencies:
   `npm install` 
7. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key 
8. Run the app: 
   `npm run dev` 
9. mp2 install (opicional) 
