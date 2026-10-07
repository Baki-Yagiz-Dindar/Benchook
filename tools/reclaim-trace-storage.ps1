param([Parameter(Mandatory=$true)][string]$LogPath, [Parameter(Mandatory=$true)][long]$EndOffset)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WorkflowSparse {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] input,
    uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  public static void Clear(string path, long end) {
    if(end <= 0) throw new ArgumentException("Invalid range");
    using(var file = new FileStream(path, FileMode.Open, FileAccess.Write,
      FileShare.ReadWrite | FileShare.Delete)) {
      if(end > file.Length) throw new ArgumentException("Range exceeds file");
      uint returned;
      if(!DeviceIoControl(file.SafeFileHandle, 0x000900C4, null, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      byte[] range = new byte[16];
      Buffer.BlockCopy(BitConverter.GetBytes(end), 0, range, 8, 8);
      if(!DeviceIoControl(file.SafeFileHandle, 0x000980C8, range, 16, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
[WorkflowSparse]::Clear($LogPath, $EndOffset)
