param(
  [switch]$SelfTest,
  [int]$ProcessId = 0,
  [string]$Token = "",
  [string]$ArtifactsDirectory = $env:TEMP
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-DragDelta {
  param(
    [int]$CenterX,
    [int]$CenterY,
    [int]$ScreenWidth,
    [int]$ScreenHeight
  )

  $dx = if ($CenterX + 96 -lt $ScreenWidth) { 72 } else { -72 }
  $dy = if ($CenterY + 72 -lt $ScreenHeight) { 48 } else { -48 }
  return @{ X = $dx; Y = $dy }
}

if ($SelfTest) {
  $forward = Get-DragDelta -CenterX 100 -CenterY 100 -ScreenWidth 1920 -ScreenHeight 1080
  if ($forward.X -ne 72 -or $forward.Y -ne 48) { throw "forward drag delta is invalid" }
  $reverse = Get-DragDelta -CenterX 1900 -CenterY 1060 -ScreenWidth 1920 -ScreenHeight 1080
  if ($reverse.X -ne -72 -or $reverse.Y -ne -48) { throw "reverse drag delta is invalid" }
  "windows input smoke self-test: PASS"
  exit 0
}

if (-not $IsWindows) { throw "windows_input_smoke.ps1 requires Windows" }
if ($ProcessId -le 0) { throw "-ProcessId is required" }
if ([string]::IsNullOrWhiteSpace($Token)) { throw "-Token is required" }
if (-not (Test-Path -LiteralPath $ArtifactsDirectory)) {
  New-Item -ItemType Directory -Path $ArtifactsDirectory -Force | Out-Null
}

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PetdexInputSmokeNative {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MouseInput {
    public int Dx;
    public int Dy;
    public uint MouseData;
    public uint Flags;
    public uint Time;
    public IntPtr ExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KeyboardInput {
    public ushort VirtualKey;
    public ushort Scan;
    public uint Flags;
    public uint Time;
    public IntPtr ExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Input {
    public uint Type;
    public InputUnion Value;
  }

  const uint InputMouse = 0;
  const uint InputKeyboard = 1;
  const uint MouseLeftDown = 0x0002;
  const uint MouseLeftUp = 0x0004;
  const uint MouseRightDown = 0x0008;
  const uint MouseRightUp = 0x0010;
  const uint KeyUp = 0x0002;
  const ushort Escape = 0x1b;

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, StringBuilder className, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int capacity);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint inputCount, Input[] inputs, int inputSize);

  public static IntPtr FindPetWindow(int processId) {
    IntPtr pet = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != (uint)processId || !IsWindowVisible(hwnd)) return true;
      var title = new StringBuilder(128);
      GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString() == "Petdex") {
        pet = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return pet;
  }

  public static IntPtr FindVisibleMenu() {
    IntPtr menu = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
      if (!IsWindowVisible(hwnd)) return true;
      var name = new StringBuilder(64);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() == "#32768") {
        menu = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return menu;
  }

  static void Send(Input input) {
    var inputs = new Input[] { input };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(Input))) != 1) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  static void SendMouse(uint flags) {
    Send(new Input {
      Type = InputMouse,
      Value = new InputUnion { Mouse = new MouseInput { Flags = flags } }
    });
  }

  static void SendKey(ushort key, uint flags) {
    Send(new Input {
      Type = InputKeyboard,
      Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = flags } }
    });
  }

  public static void LeftDown() { SendMouse(MouseLeftDown); }
  public static void LeftUp() { SendMouse(MouseLeftUp); }
  public static void RightDown() { SendMouse(MouseRightDown); }
  public static void RightUp() { SendMouse(MouseRightUp); }
  public static void EscapeMenu() {
    SendKey(Escape, 0);
    SendKey(Escape, KeyUp);
  }
}
'@

function Get-PetdexWindowRect {
  # First-run CI intentionally auto-opens the much larger Settings window.
  # Match the shell window's exact title so every gesture lands on the pet
  # canvas instead of the unrelated settings HWND.
  $handle = [PetdexInputSmokeNative]::FindPetWindow($ProcessId)
  if ($handle -eq [IntPtr]::Zero) { throw "no visible Petdex pet window belongs to PID $ProcessId" }
  $rect = New-Object PetdexInputSmokeNative+Rect
  if (-not [PetdexInputSmokeNative]::GetWindowRect($handle, [ref]$rect)) {
    throw "GetWindowRect failed for Petdex window"
  }
  if ($rect.Right -le $rect.Left -or $rect.Bottom -le $rect.Top) {
    throw "Petdex window has invalid bounds"
  }
  return @{ Handle = $handle; Rect = $rect }
}

function Save-RectScreenshot {
  param([object]$Rect, [string]$Path)
  $width = $Rect.Right - $Rect.Left
  $height = $Rect.Bottom - $Rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($Rect.Left, $Rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Path)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-ScreenshotDelta {
  param([string]$BeforePath, [string]$AfterPath)
  $before = [System.Drawing.Bitmap]::FromFile($BeforePath)
  $after = [System.Drawing.Bitmap]::FromFile($AfterPath)
  try {
    if ($before.Size -ne $after.Size) { throw "input screenshots have different sizes" }
    $samples = 0
    $changed = 0
    for ($y = 0; $y -lt $before.Height; $y += 2) {
      for ($x = 0; $x -lt $before.Width; $x += 2) {
        $a = $before.GetPixel($x, $y)
        $b = $after.GetPixel($x, $y)
        $delta = [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B)
        if ($delta -ge 24) { $changed++ }
        $samples++
      }
    }
    return @{ Changed = $changed; Samples = $samples }
  } finally {
    $before.Dispose()
    $after.Dispose()
  }
}

$headers = @{ "x-petdex-update-token" = $Token }
$idle = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7777/state" `
  -Headers $headers -ContentType "application/json" -Body '{"state":"idle"}'
if (-not $idle.ok) { throw "failed to establish the idle input baseline" }
Start-Sleep -Milliseconds 450

$window = Get-PetdexWindowRect
$rect = $window.Rect
$centerX = [int](($rect.Left + $rect.Right) / 2)
$centerY = [int](($rect.Top + $rect.Bottom) / 2)
$beforePath = Join-Path $ArtifactsDirectory "windows-input-before.png"
$afterPath = Join-Path $ArtifactsDirectory "windows-input-left-click.png"
Save-RectScreenshot -Rect $rect -Path $beforePath

if (-not [PetdexInputSmokeNative]::SetCursorPos($centerX, $centerY)) { throw "SetCursorPos failed" }
[PetdexInputSmokeNative]::LeftDown()
Start-Sleep -Milliseconds 80
[PetdexInputSmokeNative]::LeftUp()
Start-Sleep -Milliseconds 300
Save-RectScreenshot -Rect $rect -Path $afterPath
$delta = Get-ScreenshotDelta -BeforePath $beforePath -AfterPath $afterPath
$minimumChanged = [Math]::Max(24, [int]($delta.Samples * 0.01))
if ($delta.Changed -lt $minimumChanged) {
  throw "real left-click produced no visible pat-state transition ($($delta.Changed)/$($delta.Samples) samples changed)"
}
$stateAfterClick = Invoke-RestMethod -Uri "http://127.0.0.1:7777/state"
if ($stateAfterClick.state -ne "idle") {
  throw "a concurrent hook state obscured the left-click oracle: $($stateAfterClick.state)"
}

if ([PetdexInputSmokeNative]::FindVisibleMenu() -ne [IntPtr]::Zero) {
  throw "a native menu was already visible before the right-click probe"
}
if (-not [PetdexInputSmokeNative]::SetCursorPos($centerX, $centerY)) { throw "SetCursorPos failed" }
[PetdexInputSmokeNative]::RightDown()
Start-Sleep -Milliseconds 80
[PetdexInputSmokeNative]::RightUp()
$menu = [IntPtr]::Zero
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $menu = [PetdexInputSmokeNative]::FindVisibleMenu()
  if ($menu -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ($menu -eq [IntPtr]::Zero) { throw "real right-click did not expose the native pet context menu" }
[PetdexInputSmokeNative]::EscapeMenu()
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if ([PetdexInputSmokeNative]::FindVisibleMenu() -eq [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ([PetdexInputSmokeNative]::FindVisibleMenu() -ne [IntPtr]::Zero) { throw "pet context menu did not dismiss" }

$beforeDrag = (Get-PetdexWindowRect).Rect
$drag = Get-DragDelta -CenterX $centerX -CenterY $centerY `
  -ScreenWidth ([System.Windows.Forms.SystemInformation]::VirtualScreen.Width) `
  -ScreenHeight ([System.Windows.Forms.SystemInformation]::VirtualScreen.Height)
if (-not [PetdexInputSmokeNative]::SetCursorPos($centerX, $centerY)) { throw "SetCursorPos failed" }
[PetdexInputSmokeNative]::LeftDown()
for ($step = 1; $step -le 6; $step++) {
  $x = $centerX + [int]($drag.X * $step / 6)
  $y = $centerY + [int]($drag.Y * $step / 6)
  if (-not [PetdexInputSmokeNative]::SetCursorPos($x, $y)) { throw "SetCursorPos failed during drag" }
  Start-Sleep -Milliseconds 70
}
# Let the app's 100 ms velocity tail settle so this probes dragging without
# starting a throw that could move the later bubble screenshot.
Start-Sleep -Milliseconds 250
[PetdexInputSmokeNative]::LeftUp()
Start-Sleep -Milliseconds 250
$afterDrag = (Get-PetdexWindowRect).Rect
$movedX = $afterDrag.Left - $beforeDrag.Left
$movedY = $afterDrag.Top - $beforeDrag.Top
if ([Math]::Abs($movedX) + [Math]::Abs($movedY) -lt 24) {
  throw "real mouse drag did not change the Petdex window rectangle"
}

$result = [ordered]@{
  processId = $ProcessId
  leftClickChangedSamples = $delta.Changed
  leftClickSampleCount = $delta.Samples
  rightClickMenuObserved = $true
  dragDelta = @($movedX, $movedY)
  stateEndpoint = $stateAfterClick.state
}
$result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ArtifactsDirectory "windows-input-smoke.json")
$result | ConvertTo-Json -Compress
"windows real-input smoke: PASS"
