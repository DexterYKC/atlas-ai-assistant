// Icône d'Atlas dans la zone de notification (à côté de l'horloge). Le nom affiché (info-bulle, menu) vient de config.json > "nom".
//   présente + verte  : le cerveau ET l'écoute fonctionnent
//   présente + orange : le cerveau tourne mais l'écoute est arrêtée
//   présente + bleue  : il vous écoute / réfléchit / parle
//   ABSENTE           : il ne tourne pas
// Compilation : tray\compiler.ps1   (compilateur C# intégré à Windows, rien à installer)
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Atlas")]
[assembly: AssemblyProduct("Atlas")]
[assembly: AssemblyDescription("Icone d'etat d'Atlas")]
[assembly: AssemblyCompany("Atlas")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Program
{
    static NotifyIcon ni;
    static Control ui;
    static string dir, token = "", nom = "Jarvis", journal;
    static int port = 8765;
    static Icon iconVert, iconOrange, iconBleu, iconRouge;
    static bool suspendu;                    // actions de l'IA suspendues (interrupteur d'urgence)
    static bool calme;                       // mode calme actif (son coupé) : voir /api/calme
    static ToolStripMenuItem itemSusp, itemCalme;

    static Icon Dessine(Color c)
    {
        using (Bitmap b = new Bitmap(32, 32))
        {
            using (Graphics g = Graphics.FromImage(b))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                using (Brush fond = new SolidBrush(Color.FromArgb(19, 26, 46))) g.FillEllipse(fond, 1, 1, 30, 30);
                using (Pen p = new Pen(c, 3)) g.DrawEllipse(p, 3, 3, 26, 26);
                using (Font f = new Font("Segoe UI", 16, FontStyle.Bold, GraphicsUnit.Pixel))
                using (Brush t = new SolidBrush(c))
                {
                    SizeF s = g.MeasureString("A", f);
                    g.DrawString("A", f, t, (32 - s.Width) / 2 + 0.5f, (32 - s.Height) / 2);
                }
            }
            return Icon.FromHandle(b.GetHicon()); // 3 icônes seulement : gardées pendant toute la vie du programme
        }
    }

    static void Charge()
    {
        string txt = File.ReadAllText(Path.Combine(dir, "config.json"), Encoding.UTF8);
        Match m = Regex.Match(txt, "\"voice_token\"\\s*:\\s*\"([^\"]+)\"");
        if (m.Success) token = m.Groups[1].Value;
        Match p = Regex.Match(txt, "\"voice_port\"\\s*:\\s*(\\d+)");
        if (p.Success) port = int.Parse(p.Groups[1].Value);
        Match n = Regex.Match(txt, "\"nom\"\\s*:\\s*\"([^\"]+)\"");
        if (n.Success) nom = n.Groups[1].Value;
    }

    static string Requete(string methode, string chemin, string corps)
    {
        HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + chemin);
        r.Method = methode; r.Timeout = 2500; r.ReadWriteTimeout = 2500; r.Proxy = null;
        r.Headers["Authorization"] = "Bearer " + token;
        if (corps != null)
        {
            r.ContentType = "application/json";
            byte[] d = Encoding.UTF8.GetBytes(corps);
            r.ContentLength = d.Length;
            using (Stream s = r.GetRequestStream()) s.Write(d, 0, d.Length);
        }
        using (WebResponse w = r.GetResponse())
        using (StreamReader sr = new StreamReader(w.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    static void Log(string s)
    {
        try { File.WriteAllText(journal, DateTime.Now.ToString("HH:mm:ss") + "  " + s + Environment.NewLine); } catch { }
    }

    static void Appliquer(bool ok, string etat, int vue)
    {
        if (!ok) { ni.Visible = false; Log(nom + " ne repond pas -> icone masquee"); return; }
        Icon ic; string txt;
        if (vue < 0 || vue > 40) { ic = iconOrange; txt = nom + " : en marche, mais l'écoute est arrêtée"; }
        else if (etat == "ecoute") { ic = iconBleu; txt = nom + " : je vous écoute"; }
        else if (etat == "reflechit") { ic = iconBleu; txt = nom + " : je réfléchis"; }
        else if (etat == "parle") { ic = iconBleu; txt = nom + " : je parle"; }
        else { ic = iconVert; txt = nom + " : tout fonctionne"; }
        if (suspendu) { ic = iconRouge; txt = nom + " : ACTIONS SUSPENDUES (il répond, mais ne déclenche rien)"; }
        if (calme) txt = nom + " : son coupé (mode calme)";
        if (itemSusp != null) itemSusp.Text = suspendu ? "Reprendre les actions de " + nom : "Suspendre les actions de " + nom + " (urgence)";
        if (itemCalme != null) itemCalme.Text = calme ? "Réactiver le son" : "Couper le son";
        ni.Visible = true;
        if (!object.ReferenceEquals(ni.Icon, ic)) ni.Icon = ic;
        // Windows limite l'info-bulle d'une icône système à 63 caractères : au-delà, elle est tronquée sans prévenir.
        ni.Text = txt.Length > 63 ? txt.Substring(0, 63) : txt;
        Log(txt + "  (etat=" + etat + ", ecoute vue il y a " + vue + " s)");
    }

    static void Surveille()
    {
        while (true)
        {
            bool ok = false; string etat = "repos"; int vue = -1;
            try
            {
                Charge();
                string j = Requete("GET", "/ecoute/etat", null);
                Match m = Regex.Match(j, "\"etat\"\\s*:\\s*\"(\\w+)\"");
                if (m.Success) etat = m.Groups[1].Value;
                Match v = Regex.Match(j, "\"vue\"\\s*:\\s*(-?\\d+)");
                if (v.Success) vue = int.Parse(v.Groups[1].Value);
                Match sp = Regex.Match(j, "\"suspendu\"\\s*:\\s*(true|false)");
                suspendu = sp.Success && sp.Groups[1].Value == "true";
                string jc = Requete("GET", "/api/calme", null);
                Match cm = Regex.Match(jc, "\"actif\"\\s*:\\s*(true|false)");
                calme = cm.Success && cm.Groups[1].Value == "true";
                ok = true;
            }
            catch { ok = false; }
            try { bool o = ok; string e = etat; int vv = vue; ui.BeginInvoke(new MethodInvoker(delegate { Appliquer(o, e, vv); })); } catch { }
            Thread.Sleep(3000);
        }
    }

    static void Lance(string exe, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.CreateNoWindow = true; psi.UseShellExecute = false; psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        catch { }
    }

    static void Ouvrir()
    {
        Lance("powershell", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(dir, "devant.ps1") + "\" -Titre \"" + nom + "\" -Url http://localhost:" + port);
    }

    [STAThread]
    static void Main()
    {
        bool nouveau;
        using (Mutex mx = new Mutex(true, "JarvisTrayIcone", out nouveau))
        {
            if (!nouveau) return;
            dir = AppDomain.CurrentDomain.BaseDirectory;
            journal = Path.Combine(Path.GetTempPath(), "jarvis_tray.log");
            try { Charge(); } catch { }
            Application.EnableVisualStyles();
            iconVert = Dessine(Color.FromArgb(46, 204, 113));
            iconOrange = Dessine(Color.FromArgb(243, 156, 18));
            iconBleu = Dessine(Color.FromArgb(52, 152, 219));
            iconRouge = Dessine(Color.FromArgb(231, 76, 60));

            ui = new Control();
            IntPtr force = ui.Handle; // crée la fenêtre technique qui reçoit les mises à jour

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Ouvrir " + nom, null, delegate { Ouvrir(); });
            menu.Items.Add("Ouvrir les projets (grande fenêtre)", null, delegate { try { Requete("GET", "/projets/ouvrir", null); } catch { } });
            menu.Items.Add("Taille par défaut de la fenêtre", null, delegate { try { Requete("GET", "/fenetre/defaut", null); } catch { } });
            menu.Items.Add("Couper l'écoute en cours", null, delegate { try { Requete("POST", "/ecoute/annuler", "{}"); } catch { } });
            itemCalme = new ToolStripMenuItem("Couper le son");
            itemCalme.Click += delegate { try { Requete("POST", "/api/calme", calme ? "{\"fin\":true}" : "{\"jusqu\":\"+720\"}"); } catch { } };
            menu.Items.Add(itemCalme);
            itemSusp = new ToolStripMenuItem("Suspendre les actions de " + nom + " (urgence)");
            itemSusp.Click += delegate { try { Requete("POST", "/securite/suspendre", suspendu ? "{\"suspendu\":false}" : "{\"suspendu\":true}"); } catch { } };
            menu.Items.Add(itemSusp);
            menu.Items.Add("Redémarrer " + nom, null, delegate
            {
                // Cerveau ET écoute : le cerveau (jarvis.js) et l'écoute (ecoute.py) se relancent tout seuls dès qu'on les arrête
                // (start-jarvis.bat / start-ecoute.bat tournent déjà en boucle) — on ne cible QUE ces deux process précis, jamais leur fenêtre d'habillage.
                Lance("powershell", "-NoProfile -WindowStyle Hidden -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'jarvis\\.js|ecoute\\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"");
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quitter l'icône", null, delegate { ni.Visible = false; ni.Dispose(); Application.Exit(); });

            ni = new NotifyIcon();
            ni.ContextMenuStrip = menu;
            ni.Icon = iconOrange;
            ni.Text = nom;
            ni.Visible = false; // affichée seulement quand Jarvis répond
            ni.DoubleClick += delegate { Ouvrir(); };

            Thread t = new Thread(Surveille);
            t.IsBackground = true;
            t.Start();
            Application.Run();
        }
    }
}
