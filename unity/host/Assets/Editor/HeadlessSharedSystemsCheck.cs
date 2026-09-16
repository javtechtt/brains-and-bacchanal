using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of the Phase 6 shared systems — DEVELOPMENT ONLY.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode. The
    /// counterpart to <see cref="HeadlessEngineCheck"/>, covering
    /// <c>SharedMessages.cs</c> instead of the Phase 5 engine DTOs.
    ///
    /// It exists for the same reason: compiling proves nothing about the wire,
    /// and JsonUtility fails QUIETLY — a field that does not match the server's
    /// JSON deserialises to zero or null rather than throwing. A drift in
    /// <c>BacchanalCardInstance</c>, <c>ClashView</c> or <c>MarketPurchaseView</c>
    /// would show up as an empty hand or a "0 BB" purchase on a TV in front of a
    /// room of people, not as an error.
    ///
    /// ALSO CHECKS THE HIDDEN-INFORMATION BOUNDARY, the same way
    /// <c>apps/game-server/src/rooms/shared-network.test.ts</c> does on the
    /// TypeScript side: by reading the RAW JSON a real client receives and
    /// asserting an opponent's card instance id is not a substring of it. A
    /// perfectly shaped DTO can still leak if the wrong object is serialised
    /// into a snapshot; this is the only way to catch that from the C# side.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessSharedSystemsCheck.Run
    ///
    /// Server host/port come from BB_SERVER_HOST / BB_SERVER_PORT. The Market
    /// affordability check and the Host Deal check need no development flag —
    /// unlike HeadlessEngineCheck's floor test, everything here is production
    /// intent traffic.
    /// </summary>
    public static class HeadlessSharedSystemsCheck
    {
        private static int _checks;
        private static int _failures;

        public static void Run()
        {
            var host = Environment.GetEnvironmentVariable("BB_SERVER_HOST");
            if (string.IsNullOrEmpty(host)) host = "127.0.0.1";

            var portText = Environment.GetEnvironmentVariable("BB_SERVER_PORT");
            if (!int.TryParse(portText, out var port)) port = 4000;

            try
            {
                // Task.Run + ConfigureAwait(false) throughout — see
                // HeadlessEngineCheck's header comment for why.
                Task.Run(() => RunAsync(host, port)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Fail("unhandled exception: " + ex);
            }

            Debug.Log($"[BBSHARED] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBSHARED] connecting to {url}");

            // ---- Set up a room, two teams, a started game ----------------------
            var hostClient = new BenchmarkWebSocketClient { RoomId = "pending" };
            var connected = await hostClient.ConnectAsync(url).ConfigureAwait(false);
            Check("host connects", connected, hostClient.LastError);
            if (!connected) return;

            var createAck = await hostClient.SubmitAsync(RoomIntents.CreateRoom, "{}").ConfigureAwait(false);
            if (createAck == null || !createAck.ok) { Fail("CREATE_ROOM: " + Describe(createAck)); return; }

            var created = JsonUtility.FromJson<RoomCreatedPayload>(createAck.snapshotJson);
            if (created == null) { Fail("room payload did not parse"); return; }
            hostClient.RoomId = created.roomId;

            var p1 = await JoinPlayer(url, created, "Unity Shared P1").ConfigureAwait(false);
            var p2 = await JoinPlayer(url, created, "Unity Shared P2").ConfigureAwait(false);
            if (p1 == null || p2 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            var startAck = await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);
            Check("game started", startAck != null && startAck.ok, Describe(startAck));

            var game = await GameSnapshot(hostClient).ConfigureAwait(false);
            // `shared` populates as soon as the game has started (empty
            // subsystems, not null) — room.ts keys it on `game.started`, not on
            // whether cards have been dealt yet. The Maco deck is unbuilt and the
            // cardWindow closed until later intents create real state, which is
            // what actually distinguishes "just started" from "cards dealt".
            Check("shared is populated once the game starts", game?.shared != null,
                "shared was null");
            Check("card window is closed before any window is opened",
                game?.shared?.cardWindow == null || !game.shared.cardWindow.open,
                "cardWindow.open=" + (game?.shared?.cardWindow?.open ?? false));

            // ---- Deal Bacchanal cards -------------------------------------------
            var dealAck = await hostClient.SubmitAsync(SharedIntents.DealBacchanalCards, "{}")
                .ConfigureAwait(false);
            Check("cards dealt", dealAck != null && dealAck.ok, Describe(dealAck));

            var p1Snap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            var p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);

            Check("Team A hand has 3 cards",
                p1Snap?.shared?.yourHand != null && p1Snap.shared.yourHand.Length == 3,
                "count=" + (p1Snap?.shared?.yourHand?.Length ?? -1));
            Check("Team B hand has 3 cards",
                p2Snap?.shared?.yourHand != null && p2Snap.shared.yourHand.Length == 3,
                "count=" + (p2Snap?.shared?.yourHand?.Length ?? -1));

            var categories = new HashSet<string>();
            foreach (var card in p1Snap?.shared?.yourHand ?? Array.Empty<OwnCardView>())
            {
                categories.Add(card.category);
            }
            // GAME_RULES_LOCKED.md §2 — one card from each of the three categories.
            Check("Team A holds one card per category", categories.Count == 3,
                "categories=" + string.Join(",", categories));

            // ---- THE HIDDEN-INFORMATION BOUNDARY, against raw wire bytes --------
            // Phase 6 spec §42. Not "does the DTO have the right shape" but "is
            // the opponent's actual card instance id present anywhere in the
            // bytes this player received". Mirrors the TypeScript network test.
            var teamBCardIds = new List<string>();
            foreach (var card in p2Snap?.shared?.yourHand ?? Array.Empty<OwnCardView>())
            {
                teamBCardIds.Add(card.cardInstanceId);
            }
            var p1RawJson = await RawGameSnapshotJson(p1.Client).ConfigureAwait(false);
            var leaked = false;
            foreach (var id in teamBCardIds)
            {
                if (!string.IsNullOrEmpty(p1RawJson) && p1RawJson.Contains(id)) leaked = true;
            }
            Check("Team B's card instance ids are NOT present in Team A's snapshot bytes",
                !leaked, "an opponent card id leaked into the wire payload");

            Check("Team A sees Team B only as a count",
                p1Snap?.shared?.opponentHands != null &&
                p1Snap.shared.opponentHands.Length == 1 &&
                p1Snap.shared.opponentHands[0].cardCount == 3,
                "opponentHands=" + Describe(p1Snap?.shared?.opponentHands));

            // ---- Card play authority: the acting team comes from the socket ----
            await hostClient.SubmitAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}")
                .ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.PrepareChallenge,
                "{\"challengeType\":\"UNITY_SHARED_TEST\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartChallenge, "{}").ConfigureAwait(false);
            var windowAck = await hostClient.SubmitAsync(SharedIntents.OpenCardWindow,
                "{\"challengeKind\":\"" + CardChallengeKinds.ThinkFast + "\"}").ConfigureAwait(false);
            Check("card window opened", windowAck != null && windowAck.ok, Describe(windowAck));

            p1Snap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            var playableCard = FindPlayable(p1Snap?.shared?.yourHand);

            if (playableCard != null)
            {
                // p2 tries to play p1's card — must be refused, because the
                // acting team is resolved from the CONNECTION, never the payload.
                var stolen = await p2.Client.SubmitAsync(SharedIntents.PlayBacchanalCard,
                    "{\"cardInstanceId\":\"" + playableCard.cardInstanceId + "\"}")
                    .ConfigureAwait(false);
                Check("a team cannot play another team's card",
                    stolen != null && !stolen.ok, Describe(stolen));

                var played = await p1.Client.SubmitAsync(SharedIntents.PlayBacchanalCard,
                    "{\"cardInstanceId\":\"" + playableCard.cardInstanceId + "\",\"targetTeamId\":\"TEAM_B\"}")
                    .ConfigureAwait(false);
                Check("Team A plays its own card", played != null && played.ok, Describe(played));

                // One card per team per challenge (GAME_RULES_LOCKED.md §2).
                p1Snap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
                var second = FindPlayable(p1Snap?.shared?.yourHand);
                if (second != null)
                {
                    var secondPlay = await p1.Client.SubmitAsync(SharedIntents.PlayBacchanalCard,
                        "{\"cardInstanceId\":\"" + second.cardInstanceId + "\",\"targetTeamId\":\"TEAM_B\"}")
                        .ConfigureAwait(false);
                    Check("a second card in the same challenge is refused",
                        secondPlay != null && !secondPlay.ok, Describe(secondPlay));
                }

                // ---- The Clash: response hidden until reveal --------------------
                p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);
                var counter = FindPlayable(p2Snap?.shared?.yourHand);
                if (counter != null)
                {
                    var responded = await p2.Client.SubmitAsync(SharedIntents.RespondToClash,
                        "{\"cardInstanceId\":\"" + counter.cardInstanceId + "\",\"targetTeamId\":\"TEAM_A\"}")
                        .ConfigureAwait(false);
                    Check("Team B counters", responded != null && responded.ok, Describe(responded));

                    var duringRaw = await RawGameSnapshotJson(p1.Client).ConfigureAwait(false);
                    var duringSnap = string.IsNullOrEmpty(duringRaw)
                        ? null : JsonUtility.FromJson<PlayerGameSnapshot>(duringRaw);
                    if (duringSnap?.shared?.clash != null && !duringSnap.shared.clash.resolved)
                    {
                        Check("Team A cannot see Team B's counter card before the reveal",
                            duringRaw != null && !duringRaw.Contains(counter.cardInstanceId),
                            "counter card id found in Team A's raw snapshot");
                        Check("Team A DOES see that Team B responded",
                            duringSnap.shared.clash.respondedTeamIds != null &&
                            Array.IndexOf(duringSnap.shared.clash.respondedTeamIds, "TEAM_B") >= 0,
                            "respondedTeamIds=" + Describe(duringSnap.shared.clash.respondedTeamIds));
                    }

                    // Wait out the locked 3-second window, plus the server tick.
                    await Task.Delay(3600).ConfigureAwait(false);

                    var afterClash = await PlayerGameSnapshot(hostClient).ConfigureAwait(false);
                    var clash = afterClash?.shared?.clash;
                    Check("Clash resolved by the server tick, not an intent",
                        clash == null || clash.resolved, "clash still open");
                    if (clash?.result != null)
                    {
                        // outcome, entries and explanation are all real fields on
                        // ClashResult / ClashEntryView — this proves they parsed.
                        Check("Clash result names an outcome",
                            !string.IsNullOrEmpty(clash.result.outcome), "outcome empty");
                        Check("Clash result carries an explanation",
                            !string.IsNullOrEmpty(clash.result.explanation), "explanation empty");
                    }
                }
            }
            else
            {
                Debug.Log("[BBSHARED] SKIP card-play/Clash checks — no playable card for THINK_FAST this deal");
            }

            // ---- The Market: affordability, hidden shopping, reveal ------------
            var marketAck = await hostClient.SubmitAsync(SharedIntents.OpenMarket, "{\"round\":2}")
                .ConfigureAwait(false);
            Check("Market opens before Round 2", marketAck != null && marketAck.ok, Describe(marketAck));

            var tooEarly = await hostClient.SubmitAsync(SharedIntents.OpenMarket, "{\"round\":1}")
                .ConfigureAwait(false);
            Check("Market refuses Round 1", tooEarly != null && !tooEarly.ok, Describe(tooEarly));

            var bought = await p1.Client.SubmitAsync(SharedIntents.PurchaseMarketItem,
                "{\"item\":\"EXTRA_TIME\"}").ConfigureAwait(false);
            Check("Team A buys Extra Time", bought != null && bought.ok, Describe(bought));

            p1Snap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            Check("Team A charged 200 BB — real int, not a JsonUtility zero",
                BbOf(p1Snap, "TEAM_A") == 800, "bb=" + BbOf(p1Snap, "TEAM_A"));
            Check("Team A's purchase is visible to Team A",
                p1Snap?.shared?.market?.yourPurchases != null &&
                p1Snap.shared.market.yourPurchases.Length == 1 &&
                p1Snap.shared.market.yourPurchases[0].pricePaid == 200,
                "purchases=" + Describe(p1Snap?.shared?.market?.yourPurchases));

            await p2.Client.SubmitAsync(SharedIntents.PurchaseMarketItem, "{\"item\":\"CLUE\"}")
                .ConfigureAwait(false);

            var hiddenSnap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            Check("Team B's purchase is HIDDEN from Team A while the Market is open",
                hiddenSnap?.shared?.market?.otherTeamPurchases != null &&
                hiddenSnap.shared.market.otherTeamPurchases.Length == 0,
                "otherTeamPurchases=" + Describe(hiddenSnap?.shared?.market?.otherTeamPurchases));

            await hostClient.SubmitAsync(SharedIntents.CloseMarket, "{}").ConfigureAwait(false);
            var revealedSnap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            Check("Team B's purchase reveals after the Market closes",
                revealedSnap?.shared?.market?.otherTeamPurchases != null &&
                revealedSnap.shared.market.otherTeamPurchases.Length == 1 &&
                revealedSnap.shared.market.otherTeamPurchases[0].item == "CLUE",
                "otherTeamPurchases=" + Describe(revealedSnap?.shared?.market?.otherTeamPurchases));

            // ---- Maco Mail: draw, resolve, counts-only deck ----------------------
            var drawAck = await hostClient.SubmitAsync(SharedIntents.DrawMacoMail,
                "{\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            Check("Maco Mail draw succeeds", drawAck != null && drawAck.ok, Describe(drawAck));

            p1Snap = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            Check("Team A's draw is visible to Team A",
                p1Snap?.shared?.yourMacoDraws != null && p1Snap.shared.yourMacoDraws.Length == 1,
                "count=" + (p1Snap?.shared?.yourMacoDraws?.Length ?? -1));
            Check("Maco deck exposes counts only — 19 left, no order field on the type",
                p1Snap?.shared?.macoDeck != null && p1Snap.shared.macoDeck.drawPileCount == 19,
                "drawPileCount=" + (p1Snap?.shared?.macoDeck?.drawPileCount ?? -1));

            p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);
            Check("Team B cannot see Team A's draw",
                p2Snap?.shared?.yourMacoDraws != null && p2Snap.shared.yourMacoDraws.Length == 0,
                "count=" + (p2Snap?.shared?.yourMacoDraws?.Length ?? -1));

            // ---- Host Deal: server-side terms, one per round ----------------------
            var dealOffered = await hostClient.SubmitAsync(SharedIntents.OfferDeal,
                "{\"template\":\"" + HostDealTemplates.KeepOrRisk + "\",\"teamId\":\"TEAM_B\","
                + "\"declineBb\":99999}").ConfigureAwait(false);
            Check("Host Deal offered", dealOffered != null && dealOffered.ok, Describe(dealOffered));

            p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);
            var deal = p2Snap?.shared?.yourDeal;
            Check("deal terms come from the SERVER, not the injected client amount",
                deal != null && deal.terms != null && deal.terms.declineBb == 500,
                "declineBb=" + (deal?.terms?.declineBb ?? -1));

            var secondDeal = await hostClient.SubmitAsync(SharedIntents.OfferDeal,
                "{\"template\":\"" + HostDealTemplates.MysteryDeal + "\",\"teamId\":\"TEAM_A\"}")
                .ConfigureAwait(false);
            Check("a second Host Deal in the same round is refused (D-009)",
                secondDeal != null && !secondDeal.ok, Describe(secondDeal));

            if (deal != null)
            {
                // Measured as a DELTA, not an absolute balance: Team B already
                // spent 200 on a Clue earlier in this run, so its balance before
                // the deal is not the untouched starting 1,000.
                var bbBeforeDeal = BbOf(p2Snap, "TEAM_B");

                var answered = await p2.Client.SubmitAsync(SharedIntents.RespondToHostDeal,
                    "{\"dealId\":\"" + deal.dealId + "\",\"choice\":\"decline\"}").ConfigureAwait(false);
                Check("Team B declines the deal", answered != null && answered.ok, Describe(answered));

                p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);
                Check("Team B gained the LOCKED 500, not the injected 99999",
                    BbOf(p2Snap, "TEAM_B") - bbBeforeDeal == 500,
                    $"delta={BbOf(p2Snap, "TEAM_B") - bbBeforeDeal}");
            }

            // ---- The generic wager: cap, lock, resolve once -----------------------
            var tooBig = await p2.Client.SubmitAsync(SharedIntents.ProposeWager, "{\"amount\":10000}")
                .ConfigureAwait(false);
            Check("a wager above 50% of current BB is refused",
                tooBig != null && !tooBig.ok, Describe(tooBig));

            var wagerAck = await p2.Client.SubmitAsync(SharedIntents.ProposeWager, "{\"amount\":500}")
                .ConfigureAwait(false);
            Check("a valid wager locks", wagerAck != null && wagerAck.ok, Describe(wagerAck));

            p2Snap = await PlayerGameSnapshot(p2.Client).ConfigureAwait(false);
            var wager = p2Snap?.shared?.yourWagers != null && p2Snap.shared.yourWagers.Length > 0
                ? p2Snap.shared.yourWagers[0] : null;
            Check("wager parsed with status=locked",
                wager != null && wager.status == "locked", "status=" + wager?.status);

            if (wager != null)
            {
                var cheated = await p2.Client.SubmitAsync(SharedIntents.ResolveWager,
                    "{\"wagerId\":\"" + wager.wagerId + "\",\"won\":true}").ConfigureAwait(false);
                Check("a player cannot resolve their own wager",
                    cheated != null && !cheated.ok, Describe(cheated));

                var resolved = await hostClient.SubmitAsync(SharedIntents.ResolveWager,
                    "{\"wagerId\":\"" + wager.wagerId + "\",\"won\":true}").ConfigureAwait(false);
                Check("the Host resolves the wager", resolved != null && resolved.ok, Describe(resolved));

                var resolvedAgain = await hostClient.SubmitAsync(SharedIntents.ResolveWager,
                    "{\"wagerId\":\"" + wager.wagerId + "\",\"won\":true}").ConfigureAwait(false);
                Check("resolving twice is refused",
                    resolvedAgain != null && !resolvedAgain.ok, Describe(resolvedAgain));
            }

            // ---- Reconnect: nothing redraws, rebuys or repeats ---------------------
            var beforeReconnect = await PlayerGameSnapshot(p1.Client).ConfigureAwait(false);
            var handBefore = beforeReconnect?.shared?.yourHand?.Length ?? -1;
            var advBefore = beforeReconnect?.shared?.yourAdvantages?.Length ?? -1;
            var bbBefore = BbOf(beforeReconnect, "TEAM_A");

            await p1.Client.DisconnectAsync().ConfigureAwait(false);

            var returning = new BenchmarkWebSocketClient { RoomId = created.roomId };
            await returning.ConnectAsync(url).ConfigureAwait(false);
            var reconnectAck = await returning.SubmitAsync(RoomIntents2.ReconnectPlayer,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"reconnectToken\":\"" + p1.Token + "\"}")
                .ConfigureAwait(false);
            Check("Team A reconnects", reconnectAck != null && reconnectAck.ok, Describe(reconnectAck));

            var afterReconnect = await PlayerGameSnapshot(returning).ConfigureAwait(false);
            Check("hand restored, not redealt",
                (afterReconnect?.shared?.yourHand?.Length ?? -2) == handBefore,
                $"before={handBefore} after={afterReconnect?.shared?.yourHand?.Length}");
            Check("advantages restored",
                (afterReconnect?.shared?.yourAdvantages?.Length ?? -2) == advBefore,
                $"before={advBefore} after={afterReconnect?.shared?.yourAdvantages?.Length}");
            Check("BB unchanged across reconnect — nothing rebought or redrawn",
                BbOf(afterReconnect, "TEAM_A") == bbBefore,
                $"before={bbBefore} after={BbOf(afterReconnect, "TEAM_A")}");

            // ---- Cleanup -----------------------------------------------------------
            await returning.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.CloseRoom, "{}").ConfigureAwait(false);
            await hostClient.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        private sealed class JoinedPlayer
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<JoinedPlayer> JoinPlayer(
            string url, RoomCreatedPayload room, string name)
        {
            var client = new BenchmarkWebSocketClient { RoomId = "pending" };
            if (!await client.ConnectAsync(url).ConfigureAwait(false)) return null;

            var ack = await client.SubmitAsync(RoomIntents2.JoinRoom,
                "{\"roomCode\":\"" + room.roomCode + "\",\"displayName\":\"" + name + "\"}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok) return null;

            var joined = JsonUtility.FromJson<JoinAcceptedPayload>(ack.snapshotJson);
            if (joined == null) return null;

            client.RoomId = room.roomId;
            return new JoinedPlayer
            {
                Client = client,
                PlayerId = joined.playerId,
                Token = joined.reconnectToken,
            };
        }

        /// <summary>The first card in a hand the server marked playable, or null.</summary>
        private static OwnCardView FindPlayable(OwnCardView[] hand)
        {
            if (hand == null) return null;
            foreach (var card in hand)
            {
                if (card.playable) return card;
            }
            return null;
        }

        private static async Task<HostGameSnapshot> GameSnapshot(BenchmarkWebSocketClient client)
        {
            var json = await RawGameSnapshotJson(client).ConfigureAwait(false);
            return string.IsNullOrEmpty(json) ? null : JsonUtility.FromJson<HostGameSnapshot>(json);
        }

        private static async Task<PlayerGameSnapshot> PlayerGameSnapshot(BenchmarkWebSocketClient client)
        {
            var json = await RawGameSnapshotJson(client).ConfigureAwait(false);
            return string.IsNullOrEmpty(json) ? null : JsonUtility.FromJson<PlayerGameSnapshot>(json);
        }

        private static async Task<string> RawGameSnapshotJson(BenchmarkWebSocketClient client)
        {
            var ack = await client.SubmitAsync(GameIntents.RequestGameSnapshot, "{}")
                .ConfigureAwait(false);
            return ack == null || !ack.ok ? null : ack.snapshotJson;
        }

        private static int BbOf(HostGameSnapshot snapshot, string teamId)
        {
            foreach (var team in snapshot?.teams ?? Array.Empty<GameTeamView>())
            {
                if (team.teamId == teamId) return team.bb;
            }
            return -1;
        }

        private static int BbOf(PlayerGameSnapshot snapshot, string teamId)
        {
            foreach (var team in snapshot?.teams ?? Array.Empty<GameTeamView>())
            {
                if (team.teamId == teamId) return team.bb;
            }
            return -1;
        }

        private static string Describe(IntentAck ack)
        {
            if (ack == null) return "null ack";
            return ack.ok ? "ok" : $"{ack.error?.code}: {ack.error?.message}";
        }

        private static string Describe<T>(T[] array)
        {
            return array == null ? "null" : $"length={array.Length}";
        }

        private static void Check(string label, bool passed, string detail)
        {
            _checks++;
            if (passed)
            {
                Debug.Log($"[BBSHARED] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBSHARED] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBSHARED] FAIL {message}");
        }
    }
}
