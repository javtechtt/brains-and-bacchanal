using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Mono standalone build — FALLBACK, DEVELOPMENT ONLY.
    ///
    /// IL2CPP is the preferred backend for a shipped Host and is what
    /// StandaloneBuilder.cs targets. This exists because IL2CPP additionally
    /// requires a C++ toolchain (MSVC + the Windows SDK) beyond Unity's own
    /// build-support module, and that SDK is not installed on this machine.
    ///
    /// Mono needs no C++ toolchain, so it still answers the question Phase 3
    /// actually asks — "does the Unity Host work as a real .exe, outside the
    /// Editor?" — even while the IL2CPP path is blocked on a missing SDK.
    ///
    /// This is NOT a substitute for the IL2CPP result: IL2CPP/AOT is where
    /// managed-code stripping and missing AOT generics can break a networking
    /// stack that works fine under Mono. The IL2CPP build must still be run
    /// before the Host is considered proven.
    /// </summary>
    public static class StandaloneBuilderMono
    {
        private const string ScenePath = "Assets/Scenes/NetworkingTest.unity";

        [MenuItem("Brains & Bacchanal/Build Windows Host (Mono fallback)")]
        public static void BuildWindowsMono()
        {
            var outputDir = Path.GetFullPath(Path.Combine(
                Application.dataPath, "..", "Builds", "WindowsHostMono"));
            Directory.CreateDirectory(outputDir);

            var exePath = Path.Combine(outputDir, "BrainsAndBacchanalHost.exe");

            PlayerSettings.SetScriptingBackend(
                UnityEditor.Build.NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.SetManagedStrippingLevel(
                UnityEditor.Build.NamedBuildTarget.Standalone, ManagedStrippingLevel.Minimal);

            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = exePath,
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = BuildOptions.Development | BuildOptions.AllowDebugging,
            };

            Debug.Log($"[BBBUILD] Building MONO standalone to {exePath}");

            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;

            Debug.Log($"[BBBUILD] result={summary.result} errors={summary.totalErrors} "
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
