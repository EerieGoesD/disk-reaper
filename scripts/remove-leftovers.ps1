param(
  [Parameter(Mandatory = $true)][string]$InFile
)
# Removes what the user ticked in the Leftovers & Caches dialog.
#  - leftover: the whole folder goes to the Recycle Bin (can be restored).
#  - cache:    the folder's contents are deleted; the folder itself stays.
#              Files in use are skipped. Top-level entries starting with
#              "skip" are kept (Visual Studio keeps its install records in
#              folders starting with "_").
# Prints one JSON array after the ##REMOVED## marker.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System; using System.IO; using System.Runtime.InteropServices;
public static class DrRemove {
  public static long SizeOf(string root) {
    long total = 0;
    var st = new System.Collections.Generic.Stack<string>(); st.Push(root);
    while (st.Count > 0) {
      var d = st.Pop();
      try {
        foreach (var f in Directory.EnumerateFiles(d)) { try { total += new FileInfo(f).Length; } catch {} }
        foreach (var s in Directory.EnumerateDirectories(d)) {
          try { if ((File.GetAttributes(s) & FileAttributes.ReparsePoint) != 0) continue; } catch { continue; }
          st.Push(s);
        }
      } catch {}
    }
    return total;
  }

  // Deletes everything under dir, carrying on past locked files. Returns bytes freed.
  public static long EmptyFolder(string dir, string skipPrefix) {
    long freed = 0;
    try {
      foreach (var f in Directory.EnumerateFiles(dir)) {
        var name = Path.GetFileName(f);
        if (!string.IsNullOrEmpty(skipPrefix) && name.StartsWith(skipPrefix)) continue;
        freed += DeleteFile(f);
      }
      foreach (var s in Directory.EnumerateDirectories(dir)) {
        var name = Path.GetFileName(s);
        if (!string.IsNullOrEmpty(skipPrefix) && name.StartsWith(skipPrefix)) continue;
        freed += DeleteTree(s);
      }
    } catch {}
    return freed;
  }

  static long DeleteFile(string f) {
    try {
      var fi = new FileInfo(f);
      long len = fi.Length;
      if ((fi.Attributes & FileAttributes.ReadOnly) != 0) fi.Attributes = FileAttributes.Normal;
      fi.Delete();
      return len;
    } catch { return 0; }
  }

  static long DeleteTree(string dir) {
    long freed = 0;
    try {
      if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) {
        // A junction: remove the link itself, never what it points to.
        try { Directory.Delete(dir, false); } catch {}
        return 0;
      }
      foreach (var f in Directory.EnumerateFiles(dir)) freed += DeleteFile(f);
      foreach (var s in Directory.EnumerateDirectories(dir)) freed += DeleteTree(s);
      try { Directory.Delete(dir, false); } catch {}
    } catch {}
    return freed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags; public bool fAnyOperationsAborted;
    public IntPtr hNameMappings; [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

  // Sends a folder to the Recycle Bin with no dialogs of any kind.
  public static int Recycle(string path) {
    const uint FO_DELETE = 3;
    const ushort FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOERRORUI = 0x400;
    var op = new SHFILEOPSTRUCT();
    op.wFunc = FO_DELETE;
    op.pFrom = path + "\0\0";
    op.fFlags = (ushort)(FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI);
    int rc = SHFileOperation(ref op);
    if (rc == 0 && op.fAnyOperationsAborted) return -1;
    return rc;
  }
}
"@

$items = Get-Content -LiteralPath $InFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($it in @($items)) {
  $freed = 0L; $errors = @()
  foreach ($p in @($it.paths)) {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
    if ($it.kind -eq 'leftover') {
      $before = [DrRemove]::SizeOf($p)
      $rc = [DrRemove]::Recycle($p)
      if ($rc -eq 0 -and -not (Test-Path -LiteralPath $p)) { $freed += $before }
      else { $errors += "could not move to Recycle Bin (code $rc)" }
    } else {
      $freed += [DrRemove]::EmptyFolder($p, [string]$it.skip)
    }
  }
  $results += [PSCustomObject]@{
    id    = [string]$it.id
    ok    = ($errors.Count -eq 0)
    freed = [long]$freed
    error = ($errors -join '; ')
  }
}
'##REMOVED##' + (ConvertTo-Json -InputObject @($results) -Compress -Depth 4)
