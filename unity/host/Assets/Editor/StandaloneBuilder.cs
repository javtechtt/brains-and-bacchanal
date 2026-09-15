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

        [MenuItem("Brains & Bacchanal/Build Windows Host (IL2CPP)")]
        public static void BuildWindowsIl2cpp()
        {
            var outputDir = Path.GetFullPath(Path.Combine(
                Application.dataPath, "..", "Builds", "WindowsHost"));
            Directory.CreateDirectory(outputDir);

            var exePath = Path.Combine(outputDir, "BrainsAndBacchanalHost.exe");

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
                scenes = new[] { ScenePath },
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

            Debug.Log($"[BBBUILD] exeExists={File.Exists(exePath)}");
            EditorApplication.Exit(summary.result == BuildResult.Succeeded ? 0 : 1);
        }
    }
}
