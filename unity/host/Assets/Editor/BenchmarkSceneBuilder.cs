using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using BrainsAndBacchanal;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Creates the NetworkingTest scene from code — DEVELOPMENT ONLY.
    ///
    /// Built programmatically rather than authored by hand so the scene can be
    /// regenerated deterministically and created in batch mode, without anyone
    /// dragging objects in the Editor. The scene is trivial by design: a camera
    /// and one GameObject carrying NetworkingTest, which renders itself via IMGUI.
    /// </summary>
    public static class BenchmarkSceneBuilder
    {
        private const string ScenePath = "Assets/Scenes/NetworkingTest.unity";

        [MenuItem("Brains & Bacchanal/Rebuild NetworkingTest Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var cameraObject = new GameObject("Main Camera");
            var camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.06f, 0.06f, 0.08f);
            cameraObject.tag = "MainCamera";

            var controller = new GameObject("NetworkingTest");
            controller.AddComponent<NetworkingTest>();

            System.IO.Directory.CreateDirectory("Assets/Scenes");
            EditorSceneManager.SaveScene(scene, ScenePath);

            // Make it the startup scene so a standalone build launches into it.
            EditorBuildSettings.scenes = new[]
            {
                new EditorBuildSettingsScene(ScenePath, true),
            };

            Debug.Log($"[BB] Built {ScenePath} and set it as the build scene.");
        }
    }
}
