-- PARLAY_QA_PROBE client
-- Runs in the Client DataModel through execute_luau once per step and returns one JSON string: the viewport
-- size and every visible TextButton/ImageButton in PlayerGui, with its text and the LocalPlayer-relative path
-- user_mouse_input takes as instance_path (LocalPlayer.PlayerGui.Frame.Button).
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local player = Players.LocalPlayer
local gui = player and player:FindFirstChild("PlayerGui")
local camera = workspace.CurrentCamera
local out = { viewport = camera and { camera.ViewportSize.X, camera.ViewportSize.Y } or nil, buttons = {} }

local function pathOf(inst)
	local parts = {}
	while inst and inst ~= player do
		table.insert(parts, 1, inst.Name)
		inst = inst.Parent
	end
	return "LocalPlayer." .. table.concat(parts, ".")
end

-- visible means every ancestor up to the ScreenGui is shown and the ScreenGui is enabled
local function visible(g)
	local o = g
	while o and o ~= gui do
		if o:IsA("GuiObject") and not o.Visible then return false end
		if o:IsA("LayerCollector") and not o.Enabled then return false end
		o = o.Parent
	end
	return true
end

if gui then
	for _, g in gui:GetDescendants() do
		if (g:IsA("TextButton") or g:IsA("ImageButton")) and visible(g) and g.AbsoluteSize.X > 0 and g.AbsoluteSize.Y > 0 then
			out.buttons[#out.buttons + 1] = {
				path = pathOf(g),
				text = g:IsA("TextButton") and g.Text or g.Name,
				class = g.ClassName,
				x = math.floor(g.AbsolutePosition.X + g.AbsoluteSize.X / 2),
				y = math.floor(g.AbsolutePosition.Y + g.AbsoluteSize.Y / 2),
			}
		end
	end
end
return HttpService:JSONEncode(out)
