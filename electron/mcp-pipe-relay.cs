using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;

// Windows PowerShell 5.1/.NET Framework helper. Only the current SID receives pipe access.
// It relays bounded JSON lines, never authenticates clients or mutates the application DB.
public static class MichiPipeRelay {
  [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);
  private static readonly object OutputLock = new object(), SessionLock = new object();
  private static readonly Dictionary<string, StreamWriter> Writers = new Dictionary<string, StreamWriter>();
  private static readonly Dictionary<string, NamedPipeServerStream> SessionPipes = new Dictionary<string, NamedPipeServerStream>();
  private static readonly List<NamedPipeServerStream> Pipes = new List<NamedPipeServerStream>();
  private static volatile bool Closed;
  private static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 60 }; }
  private static void Emit(object packet) { lock (OutputLock) { Console.Out.WriteLine(Serializer().Serialize(packet)); Console.Out.Flush(); } }
  private static string Line(TextReader reader, int maximum) {
    var value = new StringBuilder(); int next;
    while ((next = reader.Read()) != -1) { if (next == 10) return value.ToString(); if (value.Length >= maximum) throw new IOException("PIPE_LINE_LIMIT"); value.Append((char)next); }
    if (value.Length != 0) throw new IOException("PIPE_UNTERMINATED_LINE"); return null;
  }
  private static NamedPipeServerStream Create(string name, PipeSecurity security) {
    var bytes = security.GetSecurityDescriptorBinaryForm(); var descriptor = Marshal.AllocHGlobal(bytes.Length);
    NamedPipeServerStream pipe;
    try {
      Marshal.Copy(bytes, 0, descriptor, bytes.Length);
      var attributes = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor=descriptor, Inherit=0 };
      // Byte mode + PIPE_REJECT_REMOTE_CLIENTS. ACL is present before the first connection.
      var handle = CreateNamedPipe("\\\\.\\pipe\\"+name, 0x40000003, 8, 8, 65536, 65536, 0, ref attributes);
      if (handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
      try { pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); } catch { handle.Dispose(); throw; }
    } finally { Marshal.FreeHGlobal(descriptor); }
    lock (SessionLock) Pipes.Add(pipe); return pipe;
  }
  private static void Listen(string name, PipeSecurity security, NamedPipeServerStream initial) {
    var pipe = initial;
    while (!Closed) {
      var session = Guid.NewGuid().ToString();
      try {
        pipe.WaitForConnection();
        var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
        var writer = new StreamWriter(pipe, new UTF8Encoding(false, true), 4096, true) { AutoFlush = true };
        lock (SessionLock) { Writers[session] = writer; SessionPipes[session] = pipe; }
        Emit(new { kind = "connected", sessionId = session });
        string line; while (!Closed && (line = Line(reader, 262144)) != null) Emit(new { kind = "request", sessionId = session, line = line });
      } catch { /* No raw protocol text or credential enters diagnostics. */ }
      finally { lock (SessionLock) { Writers.Remove(session); SessionPipes.Remove(session); Pipes.Remove(pipe); } pipe.Dispose(); Emit(new { kind = "closed", sessionId = session }); }
      if (!Closed) { try { pipe = Create(name, security); } catch { Closed = true; } }
    }
  }
  public static void Run(string name) {
    Console.InputEncoding = new UTF8Encoding(false, true); Console.OutputEncoding = new UTF8Encoding(false, true);
    var sid = WindowsIdentity.GetCurrent().User;
    var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(sid);
    security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
    var first = new List<NamedPipeServerStream>(); for (int i=0; i<8; i++) first.Add(Create(name, security));
    var actual = first[0].GetAccessControl();
    var rules = actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
    var ownerMatches = sid.Equals(actual.GetOwner(typeof(SecurityIdentifier)));
    var ownerRule = rules.Count == 1 ? rules[0] as PipeAccessRule : null;
    var ownerOnly = ownerRule != null && sid.Equals(ownerRule.IdentityReference) && ownerRule.AccessControlType == AccessControlType.Allow && ownerRule.PipeAccessRights == PipeAccessRights.FullControl && !ownerRule.IsInherited;
    Emit(new { kind = "ready", ownerSid = sid.Value, sddl = actual.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access), protectedDacl = actual.AreAccessRulesProtected, ruleCount = rules.Count, ownerMatches = ownerMatches, ownerOnly = ownerOnly, rejectRemoteClients = true });
    foreach (var initial in first) { var captured = initial; var thread = new Thread(() => Listen(name, security, captured)) { IsBackground = true }; thread.Start(); }
    try {
      string line; while ((line = Line(Console.In, 2097152)) != null) {
        var packet = Serializer().Deserialize<Dictionary<string,object>>(line);
        var session = (string)packet["sessionId"]; StreamWriter writer;
        if (packet.ContainsKey("close")) { NamedPipeServerStream target; lock (SessionLock) SessionPipes.TryGetValue(session, out target); if (target != null) target.Dispose(); continue; }
        lock (SessionLock) Writers.TryGetValue(session, out writer);
        if (writer != null) { try { lock (writer) { writer.WriteLine((string)packet["line"]); } } catch { /* Peer disconnected. */ } }
      }
    } finally { Closed = true; lock (SessionLock) foreach (var pipe in Pipes) pipe.Dispose(); }
  }
}
