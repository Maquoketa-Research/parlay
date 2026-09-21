-- PARLAY_QA_PROBE client
-- Runs in the Client DataModel through execute_luau once per step and returns one JSON string: the viewport
-- size, every visible TextButton/ImageButton in PlayerGui (text, parent frame, the LocalPlayer-relative path
-- user_mouse_input takes as instance_path, its centre in viewport pixels for bridges that click by pixel, and
-- whether a click could land there: interactable, active, inWindow), and the visible text labels, so a panel
-- title or a message counts as something on screen that can change. The probe records and never drops: which
-- buttons an agent may see is the runner's call (play.mjs, one filter per agent).
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local player = Players.LocalPlayer
local gui = player and player:FindFirstChild("PlayerGui")
local camera = workspace.CurrentCamera
local out = { viewport = camera and { camera.ViewportSize.X, camera.ViewportSize.Y } or nil, buttons = {}, text = {} }

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

-- a GuiObject with Interactable=false disables its descendants too, so walk the chain like visible(); pcall
-- because older classes (or a future one) may lack the property, and a probe must never die on a read
local function interactable(g)
	local o = g
	while o and o ~= gui do
		if o:IsA("GuiObject") then
			local ok, v = pcall(function() return o.Interactable end)
			if ok and v == false then return false end
		end
		o = o.Parent
	end
	return true
end

-- the centre lies inside every clipping ancestor's window (a ScrollingFrame clips to AbsoluteWindowSize, any frame
-- with ClipsDescendants to its AbsoluteSize) and inside the viewport; a tile scrolled out of view is drawn nowhere
local function inWindow(g, cx, cy)
	if camera then
		local vp = camera.ViewportSize
		if cx < 0 or cy < 0 or cx > vp.X or cy > vp.Y then return false end
	end
	local o = g.Parent
	while o and o ~= gui do
		if o:IsA("GuiObject") then
			local ok, size = pcall(function()
				if o:IsA("ScrollingFrame") then return o.AbsoluteWindowSize end
				if o.ClipsDescendants then return o.AbsoluteSize end
				return nil
			end)
			if ok and size then
				local p = o.AbsolutePosition
				if cx < p.X or cy < p.Y or cx > p.X + size.X or cy > p.Y + size.Y then return false end
			end
		end
		o = o.Parent
	end
	return true
end

if gui then
	local seenText = {}
	for _, g in gui:GetDescendants() do
		if (g:IsA("TextButton") or g:IsA("ImageButton")) and visible(g) and g.AbsoluteSize.X > 0 and g.AbsoluteSize.Y > 0 then
			local cx = math.floor(g.AbsolutePosition.X + g.AbsoluteSize.X / 2)
			local cy = math.floor(g.AbsolutePosition.Y + g.AbsoluteSize.Y / 2)
			out.buttons[#out.buttons + 1] = {
				path = pathOf(g),
				text = (g:IsA("TextButton") and g.Text ~= "" and g.Text) or g.Name,   -- an icon button with empty Text reads by its name
				parent = g.Parent and g.Parent.Name or "",
				class = g.ClassName,
				x = cx,
				y = cy,
				interactable = interactable(g),
				active = g.Active,
				inWindow = inWindow(g, cx, cy),
			}
		elseif g:IsA("TextLabel") and #out.text < 20 and g.Text ~= "" and visible(g) and g.AbsoluteSize.X > 0 then
			local t = string.sub(g.Text, 1, 60)
			if not seenText[t] then
				seenText[t] = true
				out.text[#out.text + 1] = t
			end
		end
	end
end
return HttpService:JSONEncode(out)
