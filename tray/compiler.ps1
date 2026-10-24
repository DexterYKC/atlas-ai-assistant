# Compile l'icône Jarvis (JarvisTray.exe) avec le compilateur C# fourni avec Windows. Rien à installer.
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path
$racine = Split-Path -Parent $ici
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Write-Error "Compilateur C# introuvable ($csc)"; exit 1 }
& $csc /nologo /target:winexe /codepage:65001 /out:"$racine\JarvisTray.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll "$ici\JarvisTray.cs"
if ($LASTEXITCODE -eq 0) { "OK : $racine\JarvisTray.exe" } else { exit $LASTEXITCODE }
