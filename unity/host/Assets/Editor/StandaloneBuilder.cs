using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Builds the Windows standalone Host player — DEVELOPMENT ONLY.
    ///
    /// Phase 3 requires proving the Unity Host works as a real .exe, not only
    /// inside the Editor. Uses IL2CPP because that is the scripting backend a
    /// shipped Host would use, and because IL2CPP/AOT is exactly where a
    /// networking stack is most likely to behave differently from the Editor
    /// (code stripping, missing AOT generics). Testing Mono only would leave
    /// that risk unmeasured.
    ///
    /// Output goes to unity/host/Builds/, which .gitignore excludes.
    /// </summary>
    public static class StandaloneBuilder
    {
        private const string ScenePath = "Assets/Scenes/NetworkingTest.unity";
        private const string LobbyScenePath = "Assets/Scenes/HostLobby.unity";

        /// <summary>
        /// Build the PHASE 4 Host lobby — the real Host application.
        ///
        /// Separate output directory from the benchmark build so both can exist
        /// at once: Phase 3 tooling is kept, not replaced.
        /// </summary>
        [MenuItem("Brains & Bacchanal/Build Windows Host Lobby (IL2CPP)")]
        public static void BuildLobbyIl2cpp()
        {
            Build(LobbyScenePath, "WindowsHostLobby", "BrainsAndBacchanalHost.exe");
        }

        [MenuItem("Brains & Bacchanal/Build Windows Host (IL2CPP)")]
        public static void BuildWindowsIl2cpp()
        {
            Build(ScenePath, "WindowsHost", "BrainsAndBacchanalHost.exe");
        }

        private static void Build(string scenePath, string folder, string exeName)
        {
            var outputDir = Path.GetFullPath(Path.Combine(
                Application.dataPath, "..", "Builds", folder));
            Directory.CreateDirectory(outputDir);

            var exePath = Path.Combine(outputDir, exeName);

            // IL2CPP, 64-bit Windows.
            PlayerSettings.SetScriptingBackend(
                UnityEditor.Build.NamedBuildTarget.Standalone, ScriptingImplementation.IL2CPP);

            // Managed stripping is where an IL2CPP build most often diverges from
            // the Editor: reflection-reached types get stripped. JsonUtility uses
            // reflection over the DTOs, so keep stripping minimal for this test
            // rather than debugging a stripped-type failure that is not what
            // Phase 3 is measuring.
            PlayerSettings.SetManagedStrippingLevel(
                UnityEditor.Build.NamedBuildTarget.Standalone, ManagedStrippingLevel.Minimal);

            var options = new BuildPlayerOptions
            {
                scenes = new[] { scenePath },
                locationPathName = exePath,
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                // Development build: keeps the Console/log output that makes a
                // standalone networking failure diagnosable at all.
                options = BuildOptions.Development | BuildOptions.AllowDebugging,
            };

            Debug.Log($"[BBBUILD] Building IL2CPP standalone to {exePath}");

            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;

            Debug.Log($"[BBBUILD] result={summary.result} "
                    + $"errors={summary.totalErrors} warnings={summary.totalWarnings} "
                    + $"sizeBytes={summary.totalSize} time={summary.totalTime}");

            if (summary.result != BuildResult.Succeeded)
            {
                foreach (var step in report.steps)
                {
                    foreach (var msg in step.messages)
                    {
                        if (msg.type == LogType.Error || msg.type == LogType.Exception)
                        {
                            Debug.Log($"[BBBUILD] ERROR {step.name}: {msg.content}");
                        }
                    }
                }
            }

            // Report the .exe's AGE, not merely that a file is sitting there.
            //
            // A failed build leaves the previous build's .exe in place, so a bare
            // "exeExists=True" on a failed build reads like partial success and
            // is actively misleading — it cost real debugging time once already.
            // Worse, IL2CPP often does not rewrite the launcher .exe even on a
            // SUCCESSFUL rebuild, because the compiled game code lives in
            // GameAssembly.dll and the il2cpp metadata rather than the launcher.
            // So the .exe timestamp alone proves nothing either way; these three
            // lines together are what actually tell you what you just built.
            if (File.Exists(exePath))
            {
                Debug.Log($"[BBBUILD] exe={exePath} writtenUtc={File.GetLastWriteTimeUtc(exePath):O}");

                var assembly = Path.Combine(Path.GetDirectoryName(exePath) ?? ".", "GameAssembly.dll");
                if (File.Exists(assembly))
                {
                    Debug.Log($"[BBBUILD] GameAssembly.dll writtenUtc={File.GetLastWriteTimeUtc(assembly):O} "
                            + "(this, not the .exe, carries your C# changes under IL2CPP)");
                }
            }
            else
            {
                Debug.Log("[BBBUILD] exe MISSING");
            }

            if (summary.result != BuildResult.Succeeded)
            {
                Debug.Log("[BBBUILD] BUILD FAILED — any .exe above is from an EARLIER build, not this one.");
            }

            EditorApplication.Exit(summary.result == BuildResult.Succeeded ? 0 : 1);
        }
    }
}
