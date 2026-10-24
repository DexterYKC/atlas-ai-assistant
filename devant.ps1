# Amène la fenêtre de l'appli Jarvis (Edge, mode application) au premier plan. Si elle n'est pas ouverte, la lance.
# Taille par défaut : appliquée quand la fenêtre vient d'être lancée, ou avec -Ajuster (menu de l'icône). Sinon ta taille manuelle est respectée.
param([string]$Titre = 'Jarvis', [string]$Url = 'http://localhost:8765', [int]$Largeur = 0, [int]$Hauteur = 0, [string]$Coin = 'bas-droite', [switch]$Ajuster, [switch]$Fermer, [string]$Prefere = '')

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class JarvisWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static void Fermer(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }   // WM_CLOSE : fermeture normale de la fenêtre, comme un clic sur la croix

  public static IntPtr Find(string titre) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      StringBuilder t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.ToString() == titre) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Placer(IntPtr h, int x, int y, int w, int hh) {
    if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010); // ni au premier plan ni activée : juste la position et la taille
  }

  public static string Taille(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.Right - r.Left) + "x" + (r.Bottom - r.Top); }

  public static void Devant(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // au-dessus de tout, sans bouger
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // puis retour normal
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // touche Alt : autorise le changement de fenêtre active
    SetForegroundWindow(h);
  }
}
"@
[void][JarvisWin]::SetProcessDPIAware()   # coordonnées en pixels réels, comme Edge

$lance = $false
$h = [JarvisWin]::Find($Titre)
if ($Fermer) {                      # -Fermer : ferme la fenêtre de ce titre si elle existe, sans jamais en lancer une
  if ($h -ne [IntPtr]::Zero) { [JarvisWin]::Fermer($h); Write-Output 'ferme' } else { Write-Output 'absente' }
  exit 0
}
# -Prefere <titre> : si CETTE fenêtre existe (ex. le tableau de bord "Projets", qui contient déjà Jarvis), c'est elle qu'on amène devant, et la petite fenêtre Jarvis n'est PAS relancée par-dessus.
if ($Prefere -and -not $Ajuster) {
  $hp = [JarvisWin]::Find($Prefere)
  if ($hp -ne [IntPtr]::Zero) { [JarvisWin]::Devant($hp); Write-Output 'prefere-affichee'; exit 0 }
}
if ($h -eq [IntPtr]::Zero) {
  $edge = @("$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) { Write-Output 'edge-introuvable'; exit 1 }
  Start-Process $edge -ArgumentList "--app=$Url"
  $lance = $true
  for ($i = 0; $i -lt 30 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 300; $h = [JarvisWin]::Find($Titre) }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'fenetre-introuvable'; exit 1 }

if ($Largeur -gt 0 -and $Hauteur -gt 0 -and ($Ajuster -or $lance)) {
  $wa = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  $w = [Math]::Min($Largeur, $wa.Width); $hh = [Math]::Min($Hauteur, $wa.Height); $m = 12
  switch ($Coin) {
    'haut-droite' { $x = $wa.Right - $w - $m; $y = $wa.Top + $m }
    'haut-gauche' { $x = $wa.Left + $m;       $y = $wa.Top + $m }
    'bas-gauche'  { $x = $wa.Left + $m;       $y = $wa.Bottom - $hh - $m }
    'centre'      { $x = $wa.Left + [int](($wa.Width - $w) / 2); $y = $wa.Top + [int](($wa.Height - $hh) / 2) }
    default       { $x = $wa.Right - $w - $m; $y = $wa.Bottom - $hh - $m }
  }
  [JarvisWin]::Placer($h, $x, $y, $w, $hh)
}
[JarvisWin]::Devant($h)
Start-Sleep -Milliseconds 200
$etat = if ([JarvisWin]::GetForegroundWindow() -eq $h) { 'ok-premier-plan' } else { 'ok-affichee' }
Write-Output "$etat taille=$([JarvisWin]::Taille($h))"
