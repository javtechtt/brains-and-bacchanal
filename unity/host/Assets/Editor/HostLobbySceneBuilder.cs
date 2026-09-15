using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using BrainsAndBacchanal;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Creates the HostLobby scene from code.
    ///
    /// Built programmatically for the same reason as the benchmark scene: it can
    /// be regenerated deterministically in batch mode, with no hand-dragged
    /// objects to drift or to lose in a merge.
    ///
    /// This is the Phase 4 Host scene — a camera and one GameObject carrying
    /// HostLobby, which draws itself with IMGUI. Presentation is Phase 8.
    /// </summary>
    public static class HostLobbySceneBuilder
    {
        private const string ScenePath = "Assets/Scenes/HostLobby.unity";
        private const string BenchmarkScenePath = "Assets/Scenes/NetworkingTest.unity";

        [MenuItem("Brains & Bacchanal/Rebuild HostLobby Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var cameraObject = new GameObject("Main Camera");
            var camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.06f, 0.06f, 0.08f);
            cameraObject.tag = "MainCamera";

            var controller = new GameObject("HostLobby");
            controller.AddComponent<HostLobby>();

            System.IO.Directory.CreateDirectory("Assets/Scenes");
            EditorSceneManager.SaveScene(scene, ScenePath);

            // HostLobby first, so a standalone build launches into the real Host
            // rather than the benchmark. The benchmark scene stays in the list:
            // Phase 3 tooling is kept, not deleted.
            EditorBuildSettings.scenes = new[]
            {
                new EditorBuildSettingsScene(ScenePath, true),
                new EditorBuildSettingsScene(BenchmarkScenePath, true),
            };

            Debug.Log($"[BB] Built {ScenePath} and set it as the startup scene.");
        }
    }
}
