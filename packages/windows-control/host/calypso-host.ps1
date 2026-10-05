<#
  Calypso Windows control host (owner: Trice)

  Long-lived process. Reads one JSON request per line on stdin, writes one
  JSON response per line on stdout. Runs under Windows PowerShell 5.1
  (powershell.exe, always present) or PowerShell 7 (pwsh.exe).

  Request : {"id":"..","method":"..", ...}
  Response: {"id":"..","ok":true,"result":{..}} | {"id":"..","ok":false,"error":"..","code":".."}

  Methods: ping, action, screenshot, listWindows, listProcesses, inputState,
           screenInfo, cursor, shutdown

  Interruption: before and during every injected-input action the host
  compares GetLastInputInfo against the tick of its own last injection.
  Real user mouse/keyboard input aborts the action with code "user_input".
  A stop flag file (path passed via -StopFlag) aborts with code "stopped".
#>
param(
  [string]$StopFlag = "",
  [string]$ScreenshotDir = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if (-not $ScreenshotDir) { $ScreenshotDir = Join-Path $env:TEMP "calypso-screens" }
if (-not (Test-Path $ScreenshotDir)) { New-Item -ItemType Directory -Path $ScreenshotDir -Force | Out-Null }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$script:UiaLoaded = $false
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:UiaLoaded = $true
} catch { $script:UiaLoaded = $false }

Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class CalypsoNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
    MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
    MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static void EnableDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  public static uint LastInputTick() {
    LASTINPUTINFO l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref l); return l.dwTime;
  }

  static uint Send(INPUT[] inputs) { return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  public static INPUT Mouse(uint flags, uint data) {
    INPUT i = new INPUT(); i.type = INPUT_MOUSE; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  public static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }

  public static uint MouseButton(string button, bool down) {
    uint f;
    if (button == "right") f = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
    else if (button == "middle") f = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
    else f = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    return Send(new INPUT[] { Mouse(f, 0) });
  }
  public static uint Wheel(int clicks, bool horizontal) {
    return Send(new INPUT[] { Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, (uint)(clicks * 120)) });
  }
  static bool IsExtended(ushort vk) {
    switch (vk) { case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0xA3: case 0xA5: case 0x6F: case 0x90: return true; }
    return false;
  }
  public static uint VkDown(ushort vk) { return Send(new INPUT[] { Key(vk, 0, IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0) }); }
  public static uint VkUp(ushort vk) { return Send(new INPUT[] { Key(vk, 0, KEYEVENTF_KEYUP | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0)) }); }
  public static uint UnicodeChar(char c) {
    return Send(new INPUT[] { Key(0, (ushort)c, KEYEVENTF_UNICODE), Key(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) });
  }

  public static string WindowText(IntPtr h) {
    int n = GetWindowTextLength(h); if (n <= 0) return "";
    StringBuilder sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString();
  }
  public static string ClassName(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  public static List<IntPtr> TopLevelWindows() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0) list.Add(h);
      return true; }, IntPtr.Zero);
    return list;
  }

  public static bool ForceForeground(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow(); uint pid;
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    // An ALT tap lifts the foreground lock Windows puts on background processes.
    Send(new INPUT[] { Key(0x12, 0, 0), Key(0x12, 0, KEYEVENTF_KEYUP) });
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return ok || GetForegroundWindow() == h;
  }
}
"@ -ErrorAction Stop

[CalypsoNative]::EnableDpiAwareness()

# --------------------------------------------------------------------------
# Interruption tracking
# --------------------------------------------------------------------------
$script:LastInjectTick = [uint32]0
$script:UserInputToleranceMs = 120

function Mark-Injected { $script:LastInjectTick = [CalypsoNative]::LastInputTick() }

class HostAbort : System.Exception {
  [string]$Code
  HostAbort([string]$code, [string]$message) : base($message) { $this.Code = $code }
}

function Assert-NotInterrupted {
  if ($StopFlag -and (Test-Path -LiteralPath $StopFlag)) {
    throw [HostAbort]::new("stopped", "Stopped by user")
  }
  if ($script:LastInjectTick -ne 0) {
    $last = [CalypsoNative]::LastInputTick()
    $delta = [int64]$last - [int64]$script:LastInjectTick
    if ($delta -gt $script:UserInputToleranceMs) {
      throw [HostAbort]::new("user_input", "User took control (real mouse or keyboard input detected)")
    }
  }
}

function Begin-InputAction {
  # Agent input starts here: anything the user did *before* this action is fine.
  $script:LastInjectTick = [CalypsoNative]::LastInputTick()
  if ($StopFlag -and (Test-Path -LiteralPath $StopFlag)) { throw [HostAbort]::new("stopped", "Stopped by user") }
}

# --------------------------------------------------------------------------
# Keys
# --------------------------------------------------------------------------
$script:VK = @{
  "ctrl"=0x11; "control"=0x11; "shift"=0x10; "alt"=0x12; "menu"=0x12; "win"=0x5B; "meta"=0x5B; "cmd"=0x5B; "super"=0x5B;
  "enter"=0x0D; "return"=0x0D; "tab"=0x09; "esc"=0x1B; "escape"=0x1B; "space"=0x20; "backspace"=0x08; "delete"=0x2E; "del"=0x2E;
  "insert"=0x2D; "home"=0x24; "end"=0x23; "pageup"=0x21; "pagedown"=0x22; "up"=0x26; "down"=0x28; "left"=0x25; "right"=0x27;
  "capslock"=0x14; "printscreen"=0x2C; "apps"=0x5D; "contextmenu"=0x5D;
  "volumeup"=0xAF; "volumedown"=0xAE; "volumemute"=0xAD; "playpause"=0xB3;
}
for ($i = 1; $i -le 24; $i++) { $script:VK["f$i"] = 0x6F + $i }

function Resolve-Vk([string]$key) {
  $k = $key.ToLowerInvariant()
  if ($script:VK.ContainsKey($k)) { return [uint16]$script:VK[$k] }
  if ($k.Length -eq 1) {
    $c = [char]$k.ToUpperInvariant()
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge '0' -and $c -le '9')) { return [uint16][int]$c }
    $map = @{ ';'=0xBA; '='=0xBB; ','=0xBC; '-'=0xBD; '.'=0xBE; '/'=0xBF; '`'=0xC0; '['=0xDB; '\'=0xDC; ']'=0xDD; "'"=0xDE }
    if ($map.ContainsKey($k)) { return [uint16]$map[$k] }
  }
  throw "Unknown key '$key'"
}

# --------------------------------------------------------------------------
# UI Automation
# --------------------------------------------------------------------------
function Require-Uia { if (-not $script:UiaLoaded) { throw "UI Automation is not available on this system" } }

function Get-SearchRoots {
  $roots = New-Object System.Collections.Generic.List[object]
  $fg = [CalypsoNative]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    try { $roots.Add([System.Windows.Automation.AutomationElement]::FromHandle($fg)) } catch {}
  }
  $roots.Add([System.Windows.Automation.AutomationElement]::RootElement)
  return $roots
}

function Get-ControlType([string]$name) {
  if (-not $name) { return $null }
  $field = [System.Windows.Automation.ControlType].GetField($name, [System.Reflection.BindingFlags]'Public,Static,IgnoreCase')
  if (-not $field) { throw "Unknown UIA control type '$name'" }
  return $field.GetValue($null)
}

function New-Condition([hashtable]$props) {
  $AE = [System.Windows.Automation.AutomationElement]
  $conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  foreach ($k in $props.Keys) {
    $v = $props[$k]
    switch ($k.ToLowerInvariant()) {
      "name"         { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$v))) }
      "automationid" { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, [string]$v))) }
      "classname"    { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, [string]$v))) }
      "controltype"  { $conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, (Get-ControlType $v)))) }
      default        { throw "Unsupported locator property '$k'" }
    }
  }
  if ($conds.Count -eq 0) { return [System.Windows.Automation.Condition]::TrueCondition }
  if ($conds.Count -eq 1) { return $conds[0] }
  return New-Object System.Windows.Automation.AndCondition(,$conds.ToArray())
}

function Find-InRoots($cond, [int]$index = 0) {
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  foreach ($root in (Get-SearchRoots)) {
    if ($index -le 0) {
      $el = $root.FindFirst($scope, $cond)
      if ($el) { return $el }
    } else {
      $all = $root.FindAll($scope, $cond)
      if ($all.Count -gt $index) { return $all[$index] }
    }
  }
  return $null
}

# Path syntax: segments separated by "/", each "ControlType[prop=value,prop2=value]#index".
# Example: "Window[name=Untitled - Notepad]/Document" or "Pane/Button[name=OK]#1"
function Parse-PathSegment([string]$seg) {
  $m = [regex]::Match($seg, '^\s*(?<type>[A-Za-z]*)\s*(\[(?<props>[^\]]*)\])?\s*(#(?<idx>\d+))?\s*$')
  if (-not $m.Success) { throw "Bad path segment '$seg'" }
  $props = @{}
  if ($m.Groups['type'].Value) { $props['controlType'] = $m.Groups['type'].Value }
  if ($m.Groups['props'].Success) {
    foreach ($pair in ($m.Groups['props'].Value -split ',')) {
      if (-not $pair.Trim()) { continue }
      $kv = $pair -split '=', 2
      if ($kv.Count -ne 2) { throw "Bad property '$pair' in path segment '$seg'" }
      $props[$kv[0].Trim()] = $kv[1].Trim()
    }
  }
  $idx = 0; if ($m.Groups['idx'].Success) { $idx = [int]$m.Groups['idx'].Value }
  return @{ props = $props; index = $idx }
}

function Find-ByPath([string]$path) {
  $segments = $path -split '/' | Where-Object { $_.Trim() -ne '' }
  $current = $null
  $first = $true
  foreach ($s in $segments) {
    $p = Parse-PathSegment $s
    $cond = New-Condition $p.props
    if ($first) {
      $current = Find-InRoots $cond $p.index
      $first = $false
    } else {
      $all = $current.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($all.Count -gt $p.index) { $current = $all[$p.index] } else { $current = $null }
    }
    if (-not $current) { throw [HostAbort]::new("not_found", "No UI element matches path segment '$s' of '$path'") }
  }
  return $current
}

function Resolve-Element($locator) {
  Require-Uia
  switch ($locator.kind) {
    "automationId" { $el = Find-InRoots (New-Condition @{ automationId = $locator.automationId }) }
    "name" {
      $h = @{ name = $locator.name }
      if ($locator.controlType) { $h['controlType'] = $locator.controlType }
      $el = Find-InRoots (New-Condition $h)
    }
    "path" { return Find-ByPath $locator.path }
    default { throw "Locator kind '$($locator.kind)' is not an element locator" }
  }
  if (-not $el) { throw [HostAbort]::new("not_found", "No UI element matches $(ConvertTo-Json $locator -Compress)") }
  return $el
}

function Get-ElementRect($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { return $null }
  return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

function Describe-Element($el) {
  $c = $el.Current
  return @{
    name = $c.Name; automationId = $c.AutomationId; className = $c.ClassName
    controlType = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; processId = $c.ProcessId
    rect = (Get-ElementRect $el)
  }
}

function Get-ElementPoint($el) {
  $pt = New-Object System.Windows.Point
  if ($el.TryGetClickablePoint([ref]$pt)) { return @{ x = [int]$pt.X; y = [int]$pt.Y } }
  $r = Get-ElementRect $el
  if (-not $r -or $r.w -le 0 -or $r.h -le 0) { throw [HostAbort]::new("not_clickable", "Element has no on-screen point") }
  return @{ x = [int]($r.x + $r.w / 2); y = [int]($r.y + $r.h / 2) }
}

# Returns @{ x; y; element? } for any locator.
function Resolve-Point($locator) {
  if (-not $locator) { $p = New-Object CalypsoNative+POINT; [void][CalypsoNative]::GetCursorPos([ref]$p); return @{ x = $p.X; y = $p.Y; element = $null } }
  if ($locator.kind -eq "coords") { return @{ x = [int]$locator.x; y = [int]$locator.y; element = $null } }
  $el = Resolve-Element $locator
  $pt = Get-ElementPoint $el
  return @{ x = $pt.x; y = $pt.y; element = $el }
}

function Try-Pattern($el, $pattern) {
  $obj = $null
  if ($el.TryGetCurrentPattern($pattern, [ref]$obj)) { return $obj }
  return $null
}

# --------------------------------------------------------------------------
# Input primitives (all interruptible)
# --------------------------------------------------------------------------
function Move-To([int]$x, [int]$y) {
  Assert-NotInterrupted
  [void][CalypsoNative]::SetCursorPos($x, $y)
  Mark-Injected
}

function Click-At([int]$x, [int]$y, [string]$button = "left", [int]$count = 1) {
  Move-To $x $y
  for ($i = 0; $i -lt $count; $i++) {
    Assert-NotInterrupted
    [void][CalypsoNative]::MouseButton($button, $true)
    [void][CalypsoNative]::MouseButton($button, $false)
    Mark-Injected
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 40 }
  }
}

function Type-Text([string]$text) {
  $n = 0
  foreach ($ch in $text.ToCharArray()) {
    if (($n % 8) -eq 0) { Assert-NotInterrupted }
    if ($ch -eq "`n") { [void][CalypsoNative]::VkDown(0x0D); [void][CalypsoNative]::VkUp(0x0D) }
    elseif ($ch -eq "`r") { continue }
    elseif ($ch -eq "`t") { [void][CalypsoNative]::VkDown(0x09); [void][CalypsoNative]::VkUp(0x09) }
    else { [void][CalypsoNative]::UnicodeChar($ch) }
    Mark-Injected
    $n++
  }
}

function Press-Hotkey($keys) {
  $vks = @($keys | ForEach-Object { Resolve-Vk ([string]$_) })
  Assert-NotInterrupted
  try {
    foreach ($vk in $vks) { [void][CalypsoNative]::VkDown($vk); Mark-Injected }
  } finally {
    # Always release in reverse so a modifier is never left stuck down.
    for ($i = $vks.Count - 1; $i -ge 0; $i--) { [void][CalypsoNative]::VkUp($vks[$i]) }
    Mark-Injected
  }
}

function Focus-Element($el) {
  try { $el.SetFocus() } catch {}
}

# --------------------------------------------------------------------------
# Verification: after each input action, look again and check it took effect.
# Actions return verification = @{ status; checks; changed; note; retrySafe }:
#   passed  - we saw the intended effect
#   failed  - we saw that nothing happened (Node may retry once if retrySafe)
#   unknown - we couldn't tell; the worker should look before relying on it
# --------------------------------------------------------------------------
function New-Verification([string]$status, $checks, $changed, [string]$note, [bool]$retrySafe) {
  return @{
    status = $status
    checks = @($checks | Where-Object { $_ })
    changed = @($changed | Where-Object { $_ })
    note = $note
    retrySafe = $retrySafe
  }
}

function Safe-Pattern($el, $pattern) {
  if (-not $el) { return $null }
  try { return Try-Pattern $el $pattern } catch { return $null }
}

function Get-RuntimeKey($el) {
  if (-not $el) { return $null }
  try { return ($el.GetRuntimeId() -join '.') } catch { return $null }
}

function Get-FocusedElement {
  if (-not $script:UiaLoaded) { return $null }
  try { return [System.Windows.Automation.AutomationElement]::FocusedElement } catch { return $null }
}

function Get-ElementLabel($el) {
  if (-not $el) { return "the element" }
  try {
    $c = $el.Current
    $t = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($c.Name) { return "$t '$($c.Name)'" }
    return $t
  } catch { return "the element" }
}

function Normalize-Text([string]$s) {
  if ($null -eq $s) { return $null }
  return (($s -replace "`r`n", "`n") -replace "`r", "`n")
}

# True when $el or something inside it has keyboard focus.
function Test-HasFocus($el) {
  $f = Get-FocusedElement
  if (-not $f) { return $false }
  $target = Get-RuntimeKey $el
  if (-not $target) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $f
  for ($n = 0; $cur -and $n -lt 12; $n++) {
    if ((Get-RuntimeKey $cur) -eq $target) { return $true }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }
  return $false
}

# Text of an editable element: the text just before the caret (TextPattern),
# else the whole value (ValuePattern), else the document start. $null if unreadable.
function Read-EditText($el, [int]$tailChars) {
  if (-not $el) { return $null }
  try { if ($el.Current.IsPassword) { return $null } } catch { return $null }
  $tp = Safe-Pattern $el ([System.Windows.Automation.TextPattern]::Pattern)
  if ($tp -and $tailChars -gt 0) {
    try {
      $sel = $tp.GetSelection()
      if ($sel -and $sel.Length -gt 0) {
        $r = $sel[0].Clone()
        [void]$r.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, [System.Windows.Automation.Text.TextUnit]::Character, -$tailChars)
        return @{ kind = "caret"; text = (Normalize-Text $r.GetText(-1)) }
      }
    } catch {}
  }
  $vp = Safe-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp) { try { return @{ kind = "value"; text = (Normalize-Text ([string]$vp.Current.Value)) } } catch {} }
  if ($tp) { try { return @{ kind = "document"; text = (Normalize-Text $tp.DocumentRange.GetText(20000)) } } catch {} }
  return $null
}

function Get-UiSnapshot {
  $fg = [CalypsoNative]::GetForegroundWindow()
  $snap = @{ fg = [int64]$fg; title = [CalypsoNative]::WindowText($fg); focus = $null; text = $null }
  $f = Get-FocusedElement
  if ($f) {
    $snap.focus = Get-RuntimeKey $f
    $t = Read-EditText $f 200
    if ($t) { $snap.text = $t.text }
  }
  return $snap
}

function Compare-UiSnapshot($a, $b) {
  $changed = @()
  if ($a.fg -ne $b.fg) { $changed += "window" }
  elseif ($a.title -ne $b.title) { $changed += "title" }
  if ($a.focus -ne $b.focus) { $changed += "focus" }
  elseif ($a.text -ne $b.text) { $changed += "text" }
  return ,$changed
}

# Is the target actually on top at the click point?
#   ok = $true  -> the element under the point is the target or inside it
#   ok = $false -> another app's window is covering it
#   ok = $null  -> can't tell
function Test-HitTarget($el, [int]$x, [int]$y) {
  $hit = $null
  try { $hit = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch {}
  if (-not $hit) { return @{ ok = $null; covering = "" } }
  $target = Get-RuntimeKey $el
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $hit
  for ($n = 0; $cur -and $n -lt 25; $n++) {
    if ((Get-RuntimeKey $cur) -eq $target) { return @{ ok = $true; covering = "" } }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }
  $hitPid = 0; $elPid = 0
  try { $hitPid = $hit.Current.ProcessId; $elPid = $el.Current.ProcessId } catch {}
  $what = Get-ElementLabel $hit
  if ($hitPid -and $elPid -and $hitPid -ne $elPid) {
    $pname = "another app"; try { $pname = (Get-Process -Id $hitPid -ErrorAction Stop).ProcessName } catch {}
    return @{ ok = $false; covering = "$what ($pname)" }
  }
  return @{ ok = $null; covering = $what }
}

function Find-ScrollPattern([int]$x, [int]$y) {
  $cur = $null
  try { $cur = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch {}
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($n = 0; $cur -and $n -lt 15; $n++) {
    $sp = Safe-Pattern $cur ([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($sp) { return $sp }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }
  return $null
}

function Verify-Typed($before, $after, [string]$exp, [bool]$retrySafe) {
  if ($exp.Length -eq 0) { return New-Verification "unknown" @() @() "Nothing to type" $false }
  if ($null -eq $after) {
    return New-Verification "unknown" @("field text not readable") @() "Typed it, but this field doesn't expose its text; look at the screen to confirm" $false
  }
  $probe = $exp
  if ($probe.Length -gt 400) { $probe = $probe.Substring($probe.Length - 400) }
  if ($after.kind -eq "caret") { $hasIt = $after.text.EndsWith($probe, [StringComparison]::Ordinal) }
  else { $hasIt = $after.text.Contains($probe) }
  $same = ($null -ne $before) -and ($before.kind -eq $after.kind) -and ($before.text -ceq $after.text)
  if ($hasIt -and -not $same) {
    return New-Verification "passed" @("typed text is in the field ($($after.kind))") @("text") "" $false
  }
  if ($same) {
    return New-Verification "failed" @("field text unchanged") @() "Typed $($exp.Length) characters but the field's text didn't change; the keystrokes may have gone to another window" $retrySafe
  }
  return New-Verification "unknown" @("field changed but text differs") @("text") "The field changed but doesn't contain the exact text (autocomplete, formatting, or a length limit?); look at the screen" $false
}

# --------------------------------------------------------------------------
# Windows & processes
# --------------------------------------------------------------------------
function Get-WindowInfo([IntPtr]$h) {
  $procId = [uint32]0
  [void][CalypsoNative]::GetWindowThreadProcessId($h, [ref]$procId)
  $r = New-Object CalypsoNative+RECT
  [void][CalypsoNative]::GetWindowRect($h, [ref]$r)
  $pname = ""
  try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  return @{
    handle = [int64]$h; title = [CalypsoNative]::WindowText($h); className = [CalypsoNative]::ClassName($h)
    processId = [int]$procId; processName = $pname; minimized = [CalypsoNative]::IsIconic($h)
    foreground = ([CalypsoNative]::GetForegroundWindow() -eq $h)
    rect = @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
  }
}

function Find-Window([string]$title, $procId) {
  $wins = [CalypsoNative]::TopLevelWindows()
  foreach ($h in $wins) {
    $wpid = [uint32]0
    [void][CalypsoNative]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($procId -and [int]$wpid -ne [int]$procId) { continue }
    if ($title) {
      $t = [CalypsoNative]::WindowText($h)
      if ($t -notlike "*$title*") { continue }
    }
    return $h
  }
  return [IntPtr]::Zero
}

function Wait-ForWindow($procId, [int]$timeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $h = Find-Window $null $procId
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 100
  }
  return [IntPtr]::Zero
}

# --------------------------------------------------------------------------
# Screenshots
# --------------------------------------------------------------------------
function Get-VirtualScreen { return [System.Windows.Forms.SystemInformation]::VirtualScreen }

function Take-Screenshot($req) {
  $vs = Get-VirtualScreen
  $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
  $region = $req.region
  if ($region) { $x = [int]$region.x; $y = [int]$region.y; $w = [int]$region.w; $h = [int]$region.h }
  if ($w -le 0 -or $h -le 0) { throw "Empty screenshot region" }

  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    if ($req.drawCursor -ne $false) {
      try {
        $cp = New-Object CalypsoNative+POINT; [void][CalypsoNative]::GetCursorPos([ref]$cp)
        $cr = New-Object System.Drawing.Rectangle(($cp.X - $x), ($cp.Y - $y), 32, 32)
        [System.Windows.Forms.Cursors]::Default.Draw($g, $cr)
      } catch {}
    }
  } finally { $g.Dispose() }

  $scale = 1.0
  if ($req.scale) { $scale = [double]$req.scale }
  if ($req.maxWidth -and ($w * $scale) -gt [int]$req.maxWidth) { $scale = [double]$req.maxWidth / $w }
  $out = $bmp
  if ($scale -lt 0.999) {
    $nw = [Math]::Max(1, [int]($w * $scale)); $nh = [Math]::Max(1, [int]($h * $scale))
    $out = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($out)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    $g2.Dispose(); $bmp.Dispose()
  }

  $format = "png"; if ($req.format -eq "jpeg") { $format = "jpeg" }
  $ms = New-Object System.IO.MemoryStream
  try {
    if ($format -eq "jpeg") {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $q = 70; if ($req.quality) { $q = [int]$req.quality }
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$q)
      $out.Save($ms, $codec, $ep)
    } else {
      $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bytes = $ms.ToArray()
  } finally { $ms.Dispose(); $outW = $out.Width; $outH = $out.Height; $out.Dispose() }

  $result = @{
    width = $outW; height = $outH; scale = $scale; format = $format
    origin = @{ x = $x; y = $y }; sourceSize = @{ w = $w; h = $h }
  }
  if ($req.inline) {
    $result.base64 = [Convert]::ToBase64String($bytes)
  } else {
    $file = Join-Path $ScreenshotDir ("shot_{0}_{1}.{2}" -f ([DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")), ([guid]::NewGuid().ToString("N").Substring(0, 6)), $(if ($format -eq "jpeg") { "jpg" } else { "png" }))
    [System.IO.File]::WriteAllBytes($file, $bytes)
    $result.path = $file
  }
  return $result
}

# --------------------------------------------------------------------------
# UI tree
# --------------------------------------------------------------------------
function Read-UiTree($root, [int]$depth, [int]$maxNodes) {
  Require-Uia
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $script:nodeCount = 0
  function Walk($el, [int]$d) {
    $script:nodeCount++
    $node = Describe-Element $el
    if ($d -lt $depth -and $script:nodeCount -lt $maxNodes) {
      $kids = New-Object System.Collections.Generic.List[object]
      $child = $walker.GetFirstChild($el)
      while ($child -and $script:nodeCount -lt $maxNodes) {
        $kids.Add((Walk $child ($d + 1)))
        $child = $walker.GetNextSibling($child)
      }
      if ($kids.Count -gt 0) { $node.children = $kids.ToArray() }
    }
    return $node
  }
  $tree = Walk $root 0
  return @{ root = $tree; nodeCount = $script:nodeCount; truncated = ($script:nodeCount -ge $maxNodes) }
}

# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------
function Invoke-ComputerAction($a) {
  switch ($a.type) {
    "move" {
      Begin-InputAction
      $p = Resolve-Point $a.locator
      Move-To $p.x $p.y
      $cp = New-Object CalypsoNative+POINT; [void][CalypsoNative]::GetCursorPos([ref]$cp)
      if ($cp.X -eq $p.x -and $cp.Y -eq $p.y) { $v = New-Verification "passed" @("cursor at target") @() "" $false }
      else { $v = New-Verification "failed" @("cursor at ($($cp.X), $($cp.Y))") @() "The cursor ended at ($($cp.X), $($cp.Y)) instead of ($($p.x), $($p.y))" $true }
      return @{ x = $p.x; y = $p.y; method = "cursor"; verified = ($v.status -eq "passed"); verification = $v }
    }
    { $_ -in "click", "doubleClick", "rightClick" } {
      $button = "left"; $count = 1
      if ($a.type -eq "rightClick") { $button = "right" }
      elseif ($a.type -eq "doubleClick") { $count = 2 }
      elseif ($a.button) { $button = [string]$a.button }
      Begin-InputAction
      $p = Resolve-Point $a.locator
      if ($p.element) {
        $enabled = $true; try { $enabled = $p.element.Current.IsEnabled } catch {}
        if (-not $enabled) { throw [HostAbort]::new("not_clickable", "$(Get-ElementLabel $p.element) is disabled right now; nothing was clicked") }
      }
      $label = Get-ElementLabel $p.element
      # Semantic first: plain left click on an element that supports Invoke.
      if ($p.element -and $a.type -eq "click" -and $button -eq "left" -and -not $a.forceMouse) {
        $inv = Try-Pattern $p.element ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($inv) {
          $inv.Invoke()
          $v = New-Verification "passed" @("invoked via UI Automation") @() "" $false
          return @{ method = "uia_invoke"; element = (Describe-Element $p.element); verified = $true; verification = $v }
        }
        $toggle = Try-Pattern $p.element ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($toggle) {
          $tsBefore = $null; try { $tsBefore = [string]$toggle.Current.ToggleState } catch {}
          $toggle.Toggle()
          Start-Sleep -Milliseconds 60
          $tsAfter = $null; try { $tsAfter = [string]$toggle.Current.ToggleState } catch {}
          if ($null -ne $tsBefore -and $tsBefore -eq $tsAfter) {
            $v = New-Verification "failed" @("toggle still $tsAfter") @() "Clicked $label but it stayed $tsAfter" $false
          } else {
            $v = New-Verification "passed" @("toggle $tsBefore to $tsAfter") @("toggle") "" $false
          }
          return @{ method = "uia_toggle"; element = (Describe-Element $p.element); toggleState = $tsAfter; verified = ($v.status -eq "passed"); verification = $v }
        }
        $sel = Try-Pattern $p.element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($sel) {
          $sel.Select()
          Start-Sleep -Milliseconds 60
          $isSel = $null; try { $isSel = $sel.Current.IsSelected } catch {}
          if ($isSel -eq $false) { $v = New-Verification "failed" @("not selected") @() "Selected $label but it isn't selected" $true }
          else { $v = New-Verification "passed" @("selected") @("selection") "" $false }
          return @{ method = "uia_select"; element = (Describe-Element $p.element); verified = ($v.status -eq "passed"); verification = $v }
        }
      }
      $hit = @{ ok = $null; covering = "" }
      if ($p.element) {
        $hit = Test-HitTarget $p.element $p.x $p.y
        if ($hit.ok -eq $false) { throw [HostAbort]::new("not_clickable", "$label is covered by $($hit.covering); nothing was clicked") }
      }
      $snapBefore = Get-UiSnapshot
      Click-At $p.x $p.y $button $count
      Start-Sleep -Milliseconds 150
      $snapAfter = Get-UiSnapshot
      $changed = Compare-UiSnapshot $snapBefore $snapAfter
      $checks = @()
      if ($hit.ok -eq $true) { $checks += "target on top at click point" }
      if ($changed.Count -gt 0) { $checks += "changed: $($changed -join ', ')" }
      if ($changed.Count -gt 0 -or $hit.ok -eq $true) { $v = New-Verification "passed" $checks $changed "" $false }
      else { $v = New-Verification "unknown" $checks $changed "Clicked, but focus, window, and text didn't change; look at the screen to confirm it did something" $false }
      $res = @{ method = "mouse"; x = $p.x; y = $p.y; button = $button; count = $count; verified = ($v.status -eq "passed"); verification = $v }
      if ($p.element) { $res.element = Describe-Element $p.element }
      return $res
    }
    "drag" {
      Begin-InputAction
      $snapBefore = Get-UiSnapshot
      $from = Resolve-Point $a.from
      $to = Resolve-Point $a.to
      Move-To $from.x $from.y
      [void][CalypsoNative]::MouseButton("left", $true); Mark-Injected
      try {
        $steps = 20
        for ($i = 1; $i -le $steps; $i++) {
          $x = [int]($from.x + ($to.x - $from.x) * $i / $steps)
          $y = [int]($from.y + ($to.y - $from.y) * $i / $steps)
          Move-To $x $y
          Start-Sleep -Milliseconds 12
        }
      } finally {
        [void][CalypsoNative]::MouseButton("left", $false); Mark-Injected
      }
      Start-Sleep -Milliseconds 150
      $changed = Compare-UiSnapshot $snapBefore (Get-UiSnapshot)
      if ($changed.Count -gt 0) { $v = New-Verification "passed" @("changed: $($changed -join ', ')") $changed "" $false }
      else { $v = New-Verification "unknown" @() @() "Dragged; look at the screen to confirm it landed" $false }
      return @{ method = "mouse"; from = @{ x = $from.x; y = $from.y }; to = @{ x = $to.x; y = $to.y }; verified = ($v.status -eq "passed"); verification = $v }
    }
    "scroll" {
      Begin-InputAction
      if ($a.locator) { $p = Resolve-Point $a.locator; Move-To $p.x $p.y }
      $cp = New-Object CalypsoNative+POINT; [void][CalypsoNative]::GetCursorPos([ref]$cp)
      $sp = Find-ScrollPattern $cp.X $cp.Y
      $vBefore = $null; $hBefore = $null
      if ($sp) { try { $vBefore = $sp.Current.VerticalScrollPercent; $hBefore = $sp.Current.HorizontalScrollPercent } catch {} }
      $dy = 0; if ($a.deltaY) { $dy = [int]$a.deltaY }
      $dx = 0; if ($a.deltaX) { $dx = [int]$a.deltaX }
      # Contract: positive deltaY scrolls down, positive deltaX scrolls right (wheel notches).
      if ($dy -ne 0) { Assert-NotInterrupted; [void][CalypsoNative]::Wheel(-$dy, $false); Mark-Injected }
      if ($dx -ne 0) { Assert-NotInterrupted; [void][CalypsoNative]::Wheel($dx, $true); Mark-Injected }
      Start-Sleep -Milliseconds 150
      $v = New-Verification "unknown" @() @() "Scrolled; this area doesn't report its scroll position, so look at the screen to confirm" $false
      if ($sp -and $null -ne $vBefore) {
        $vAfter = $null; $hAfter = $null
        try { $vAfter = $sp.Current.VerticalScrollPercent; $hAfter = $sp.Current.HorizontalScrollPercent } catch {}
        if ($null -ne $vAfter -and ($vAfter -ne $vBefore -or $hAfter -ne $hBefore)) {
          $v = New-Verification "passed" @("scroll position $([Math]::Round($vBefore, 1))% to $([Math]::Round($vAfter, 1))%") @("scroll") "" $false
        } elseif ($null -ne $vAfter) {
          $edge = ""
          if ($dy -gt 0 -and $vAfter -ge 99.9) { $edge = " (already at the bottom)" }
          elseif ($dy -lt 0 -and $vAfter -ge 0 -and $vAfter -le 0.1) { $edge = " (already at the top)" }
          $v = New-Verification "unknown" @("scroll position unchanged$edge") @() "The scroll position didn't change$edge" $false
        }
      }
      return @{ method = "wheel"; deltaX = $dx; deltaY = $dy; verified = ($v.status -eq "passed"); verification = $v }
    }
    "type" {
      Begin-InputAction
      $text = [string]$a.text
      $refocusable = $false
      if ($a.locator -and $a.locator.kind -ne "coords") {
        $el = Resolve-Element $a.locator
        $enabled = $true; try { $enabled = $el.Current.IsEnabled } catch {}
        if (-not $enabled) { throw [HostAbort]::new("not_clickable", "$(Get-ElementLabel $el) is disabled right now; nothing was typed") }
        $vp = Try-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp -and -not $vp.Current.IsReadOnly -and -not $a.forceKeys -and $text -notmatch "`n") {
          $expected = $text
          if ($a.append) { $expected = $vp.Current.Value + $text }
          $vp.SetValue($expected)
          Start-Sleep -Milliseconds 40
          $readBack = $vp.Current.Value
          if ($readBack -ceq $expected) { $v = New-Verification "passed" @("field value matches") @("text") "" $false }
          else { $v = New-Verification "failed" @("field value differs") @() "Set the text of $(Get-ElementLabel $el) but it reads back differently" (-not $a.append) }
          return @{ method = "uia_value"; element = (Describe-Element $el); chars = $text.Length; verified = ($v.status -eq "passed"); verification = $v }
        }
        Focus-Element $el
        Start-Sleep -Milliseconds 30
        if (-not (Test-HasFocus $el)) {
          try { $pt = Get-ElementPoint $el; Click-At $pt.x $pt.y; Start-Sleep -Milliseconds 80 } catch [HostAbort] { throw } catch {}
        }
        if (-not (Test-HasFocus $el)) { throw [HostAbort]::new("not_clickable", "Couldn't put the cursor in $(Get-ElementLabel $el); nothing was typed") }
        $refocusable = $true
      } elseif ($a.locator) {
        Click-At ([int]$a.locator.x) ([int]$a.locator.y)
        Start-Sleep -Milliseconds 80
      }
      $target = Get-FocusedElement
      $exp = Normalize-Text $text
      $tail = [Math]::Min($exp.Length, 400) + 40
      $before = Read-EditText $target $tail
      Type-Text $text
      Start-Sleep -Milliseconds 120
      $after = Read-EditText $target $tail
      $v = Verify-Typed $before $after $exp $refocusable
      return @{ method = "keys"; chars = $text.Length; verified = ($v.status -eq "passed"); verification = $v }
    }
    "hotkey" {
      Begin-InputAction
      $snapBefore = Get-UiSnapshot
      Press-Hotkey $a.keys
      Start-Sleep -Milliseconds 150
      $changed = Compare-UiSnapshot $snapBefore (Get-UiSnapshot)
      if ($changed.Count -gt 0) { $v = New-Verification "passed" @("changed: $($changed -join ', ')") $changed "" $false }
      else { $v = New-Verification "unknown" @() @() "Pressed it; focus, window, and text didn't change (normal for copy and some shortcuts), so look at the screen if it should have done something" $false }
      return @{ method = "keys"; keys = $a.keys; verified = ($v.status -eq "passed"); verification = $v }
    }
    "focusWindow" {
      $h = Find-Window $a.title $a.processId
      if ($h -eq [IntPtr]::Zero) { throw [HostAbort]::new("not_found", "No visible window matches title='$($a.title)' processId='$($a.processId)'") }
      $ok = [CalypsoNative]::ForceForeground($h)
      Mark-Injected
      Start-Sleep -Milliseconds 60
      $isFg = ([CalypsoNative]::GetForegroundWindow() -eq $h)
      $checks = @()
      if (-not $isFg) {
        Start-Sleep -Milliseconds 150
        $ok = [CalypsoNative]::ForceForeground($h)
        Mark-Injected
        Start-Sleep -Milliseconds 100
        $isFg = ([CalypsoNative]::GetForegroundWindow() -eq $h)
        $checks += "second bring-to-front attempt"
      }
      $info = Get-WindowInfo $h
      if ($isFg) { $v = New-Verification "passed" ($checks + @("window is in front")) @("window") "" $false }
      else { $v = New-Verification "failed" ($checks + @("window not in front")) @() "'$($info.title)' didn't come to the front; Windows may be blocking the focus change" $true }
      return @{ focused = $ok; verified = $isFg; window = $info; verification = $v }
    }
    "launch" {
      $sp = @{ FilePath = [string]$a.path; PassThru = $true }
      if ($a.args -and @($a.args).Count -gt 0) { $sp.ArgumentList = @($a.args) }
      if ($a.cwd) { $sp.WorkingDirectory = [string]$a.cwd }
      $proc = Start-Process @sp
      $res = @{ launched = $true; path = $a.path }
      if ($proc) {
        $res.processId = $proc.Id
        $wait = 5000; if ($a.waitMs) { $wait = [int]$a.waitMs }
        $h = Wait-ForWindow $proc.Id $wait
        # Win11 Store apps (e.g. notepad.exe stub) exit and reopen under a new PID.
        if ($h -eq [IntPtr]::Zero) {
          $leaf = [IO.Path]::GetFileNameWithoutExtension([string]$a.path)
          $deadline = [DateTime]::UtcNow.AddMilliseconds($wait)
          while ([DateTime]::UtcNow -lt $deadline -and $h -eq [IntPtr]::Zero) {
            foreach ($cand in @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
              $_.ProcessName -like "$leaf*" -and $_.MainWindowHandle -ne 0
            })) {
              $h = [IntPtr]$cand.MainWindowHandle
              if ($h -ne [IntPtr]::Zero) { $res.processId = $cand.Id; break }
            }
            if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
          }
        }
        if ($h -ne [IntPtr]::Zero) {
          [CalypsoNative]::ForceForeground($h) | Out-Null
          $res.window = Get-WindowInfo $h
          $res.verified = $true
          $res.processId = $res.window.processId
        } else {
          $res.verified = (-not $proc.HasExited)
        }
      }
      return $res
    }
    "close" {
      $targets = @()
      if ($a.processId) { $targets = @(Get-Process -Id ([int]$a.processId) -ErrorAction SilentlyContinue) }
      elseif ($a.title) {
        $h = Find-Window $a.title $null
        if ($h -ne [IntPtr]::Zero) {
          $wpid = [uint32]0; [void][CalypsoNative]::GetWindowThreadProcessId($h, [ref]$wpid)
          $targets = @(Get-Process -Id ([int]$wpid) -ErrorAction SilentlyContinue)
        }
      }
      if ($targets.Count -eq 0) { throw [HostAbort]::new("not_found", "No process matches processId='$($a.processId)' title='$($a.title)'") }
      $results = @()
      foreach ($p in $targets) {
        $graceful = $p.CloseMainWindow()
        $exited = $false
        $wait = 4000; if ($a.waitMs) { $wait = [int]$a.waitMs }
        if ($graceful) { $exited = $p.WaitForExit($wait) }
        if (-not $exited -and $a.force) { Stop-Process -Id $p.Id -Force; $exited = $p.WaitForExit(2000); $how = "killed" }
        elseif ($exited) { $how = "closed" }
        else { $how = "still_running" }
        $results += @{ processId = $p.Id; processName = $p.ProcessName; result = $how }
      }
      $allGone = -not ($results | Where-Object { $_.result -eq "still_running" })
      return @{ processes = $results; verified = [bool]$allGone }
    }
    "readUiTree" {
      Require-Uia
      if ($a.root) { $root = Resolve-Element $a.root }
      else {
        $fg = [CalypsoNative]::GetForegroundWindow()
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
      }
      $depth = 4; if ($a.depth) { $depth = [int]$a.depth }
      $max = 400; if ($a.maxNodes) { $max = [int]$a.maxNodes }
      return Read-UiTree $root $depth $max
    }
    "screenshot" { return Take-Screenshot $a }
    default { throw "Unknown ComputerAction type '$($a.type)'" }
  }
}

# --------------------------------------------------------------------------
# Dispatch loop
# --------------------------------------------------------------------------
function Write-Response($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 64 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Handle-Request($req) {
  switch ($req.method) {
    "ping" { return @{ pong = $true; pid = $PID; psVersion = $PSVersionTable.PSVersion.ToString(); uia = $script:UiaLoaded } }
    "action" { return Invoke-ComputerAction $req.action }
    "screenshot" { return Take-Screenshot $req }
    "listWindows" {
      $wins = @([CalypsoNative]::TopLevelWindows() | ForEach-Object { Get-WindowInfo $_ })
      return @{ windows = $wins }
    }
    "listProcesses" {
      $procs = @(Get-Process | Where-Object { -not $req.withWindowsOnly -or $_.MainWindowHandle -ne 0 } | ForEach-Object {
        $cpu = $null; try { $cpu = [Math]::Round($_.CPU, 2) } catch {}
        @{ processId = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle; workingSetMb = [Math]::Round($_.WorkingSet64 / 1MB, 1); cpuSeconds = $cpu; responding = $_.Responding }
      })
      return @{ processes = $procs }
    }
    "inputState" {
      return @{ lastInputTick = [CalypsoNative]::LastInputTick(); lastInjectTick = $script:LastInjectTick; tickNow = [Environment]::TickCount }
    }
    "screenInfo" {
      $vs = Get-VirtualScreen
      $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        @{ name = $_.DeviceName; primary = $_.Primary; bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height } }
      })
      return @{ virtual = @{ x = $vs.X; y = $vs.Y; w = $vs.Width; h = $vs.Height }; screens = $screens }
    }
    "cursor" {
      $p = New-Object CalypsoNative+POINT; [void][CalypsoNative]::GetCursorPos([ref]$p)
      return @{ x = $p.X; y = $p.Y }
    }
    "findElement" {
      $el = Resolve-Element $req.locator
      return Describe-Element $el
    }
    "shutdown" { $script:Running = $false; return @{ bye = $true } }
    default { throw "Unknown method '$($req.method)'" }
  }
}

$script:Running = $true
Write-Response @{ id = "_ready"; ok = $true; result = @{ ready = $true; pid = $PID; uia = $script:UiaLoaded } }

while ($script:Running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $result = Handle-Request $req
    Write-Response @{ id = $id; ok = $true; result = $result }
  } catch {
    $ex = $_.Exception
    while ($ex -is [System.Management.Automation.MethodInvocationException] -and $ex.InnerException) { $ex = $ex.InnerException }
    $code = "error"
    if ($ex -is [HostAbort]) { $code = $ex.Code }
    Write-Response @{ id = $id; ok = $false; error = $ex.Message; code = $code }
  }
}
