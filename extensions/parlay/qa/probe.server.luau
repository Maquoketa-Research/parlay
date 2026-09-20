-- PARLAY_QA_PROBE server
-- Runs in the Server DataModel through execute_luau once per step and returns one JSON string:
-- player count, the test player (position, health, humanoid state, leaderstats), and the nearest ten
-- interactables (ProximityPrompt, ClickDetector, TouchTransmitter) with their world position and distance.
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local out = { placeId = game.PlaceId, placeVersion = game.PlaceVersion, players = #Players:GetPlayers() }
local player = Players:GetPlayers()[1]
if player then
	out.player = { name = player.Name, userId = player.UserId }
	local stats = player:FindFirstChild("leaderstats")
	if stats then
		out.leaderstats = {}
		for _, v in stats:GetChildren() do
			if v:IsA("ValueBase") then out.leaderstats[v.Name] = v.Value end
		end
	end
	local char = player.Character
	local root = char and char:FindFirstChild("HumanoidRootPart")
	local hum = char and char:FindFirstChildOfClass("Humanoid")
	if hum then
		out.player.health = hum.Health
		out.player.state = hum:GetState().Name
	end
	if root then
		out.player.position = { root.Position.X, root.Position.Y, root.Position.Z }
		-- where an interactable sits: its part, its attachment, or its model's pivot
		local function positionOf(inst)
			local p = inst.Parent
			if p and p:IsA("BasePart") then return p.Position end
			if p and p:IsA("Attachment") then return p.WorldPosition end
			if p and p:IsA("Model") then return p:GetPivot().Position end
			return nil
		end
		local near = {}
		for _, inst in workspace:GetDescendants() do
			if inst:IsA("ProximityPrompt") or inst:IsA("ClickDetector") or inst:IsA("TouchTransmitter") then
				local pos = positionOf(inst)
				if pos then
					near[#near + 1] = {
						class = inst.ClassName,
						path = inst:GetFullName(),
						text = inst:IsA("ProximityPrompt") and inst.ActionText or nil,
						position = { pos.X, pos.Y, pos.Z },
						distance = (pos - root.Position).Magnitude,
					}
				end
			end
		end
		table.sort(near, function(a, b) return a.distance < b.distance end)
		out.interactables = {}
		for i = 1, math.min(10, #near) do out.interactables[i] = near[i] end
	end
end
return HttpService:JSONEncode(out)
