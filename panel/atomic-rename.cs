using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class WorkflowAtomicRename {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,IntPtr data,uint size);
  public static int Main(string[] args) {
    bool committed=false;
    try {
      if(args.Length!=2){Console.Error.WriteLine("INVALID_REQUEST");return 64;}
      string source=System.IO.Path.GetFullPath(args[0]),target=System.IO.Path.GetFullPath(args[1]);
      if(!String.Equals(System.IO.Path.GetDirectoryName(source),System.IO.Path.GetDirectoryName(target),StringComparison.OrdinalIgnoreCase)){Console.Error.WriteLine("INVALID_REQUEST");return 64;}
      Rename(source,target);
      committed=true;
      Console.WriteLine("COMMITTED");return 0;
    } catch(Win32Exception e) { if(committed)return 70; Console.Error.WriteLine("NATIVE_ERROR:"+e.NativeErrorCode);return 2; }
      catch { if(committed)return 70; Console.Error.WriteLine("INVALID_REQUEST");return 64; }
  }
  public static void Rename(string source,string target) {
    using(var file=CreateFileW(source,0x10000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] name=Encoding.Unicode.GetBytes(target);
      int rootOffset=IntPtr.Size==8?8:4;
      int lengthOffset=rootOffset+IntPtr.Size;
      int nameOffset=lengthOffset+4;
      int size=nameOffset+name.Length+2;
      IntPtr data=Marshal.AllocHGlobal(size);
      try {
        Marshal.Copy(new byte[size],0,data,size);
        Marshal.WriteInt32(data,0,3); // REPLACE_IF_EXISTS | POSIX_SEMANTICS
        Marshal.WriteIntPtr(data,rootOffset,IntPtr.Zero);
        Marshal.WriteInt32(data,lengthOffset,name.Length);
        Marshal.Copy(name,0,IntPtr.Add(data,nameOffset),name.Length);
        if(!SetFileInformationByHandle(file,22,data,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(data); }
    }
  }
}
