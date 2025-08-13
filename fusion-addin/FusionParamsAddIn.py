# FusionParamsAddIn.py
# Minimal Fusion 360 add-in to import/export user parameters via JSON files.
# Fixed: proper CommandCreatedEventHandler usage (no lambdas), and placement in SolidScriptsAddinsPanel.

import adsk.core, adsk.fusion, adsk.cam, traceback, json

_app = None
_ui = None
_handlers = []  # keep references so handlers aren't GC'd

def make_value_string(val, unit):
    try:
        if unit:
            return f"{val} {unit}"
        return str(val)
    except:
        return str(val)

def upsert_user_param(userParams, name, expr_or_val, default_unit='', comment=None):
    existing = None
    for p in userParams:
        if p.name == name:
            existing = p
            break

    if isinstance(expr_or_val, str):
        expr = expr_or_val
    else:
        expr = make_value_string(expr_or_val, default_unit)

    if existing:
        existing.expression = expr
        if comment is not None:
            existing.comment = comment
    else:
        vi = adsk.core.ValueInput.createByString(expr)
        userParams.add(name, vi, default_unit or '', comment or '')

def apply_params_from_json(path):
    global _app, _ui
    try:
        design = adsk.fusion.Design.cast(_app.activeProduct)
        if not design:
            _ui.messageBox('No active Fusion design.')
            return

        with open(path, 'r') as f:
            payload = json.load(f)

        default_unit = payload.get('defaultUnit', '')
        params = payload.get('parameters', [])
        for p in params:
            name = p.get('name')
            comment = p.get('comment')
            if 'expression' in p:
                upsert_user_param(design.userParameters, name, p['expression'], '', comment)
            else:
                val = p.get('value')
                unit = p.get('unit', default_unit)
                upsert_user_param(design.userParameters, name, val, unit, comment)
        _ui.messageBox(f'Applied {len(params)} parameter(s) from:\\n{path}')
    except:
        _ui.messageBox('Failed to apply params:\\n{}'.format(traceback.format_exc()))

def export_params_to_json(path):
    global _app, _ui
    try:
        design = adsk.fusion.Design.cast(_app.activeProduct)
        if not design:
            _ui.messageBox('No active Fusion design.')
            return
        out = {
            "design": design.parentDocument.name if design.parentDocument else "ActiveDesign",
            "defaultUnit": "",  # Fusion stores unit per param via expression string; leave blank
            "parameters": []
        }
        for p in design.userParameters:
            out["parameters"].append({
                "name": p.name,
                "expression": p.expression,
                "comment": p.comment or ""
            })
        with open(path, 'w') as f:
            json.dump(out, f, indent=2)
        _ui.messageBox(f'Exported {len(out["parameters"])} parameter(s) to:\\n{path}')
    except:
        _ui.messageBox('Failed to export params:\\n{}'.format(traceback.format_exc()))

# ---- Event Handlers ----

class ImportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args: adsk.core.CommandEventArgs):
        try:
            fileDlg = _ui.createFileDialog()
            fileDlg.isMultiSelectEnabled = False
            fileDlg.title = 'Select JSON Parameter File'
            fileDlg.filter = 'JSON files (*.json)'
            if fileDlg.showOpen() != adsk.core.DialogResults.DialogOK:
                return
            apply_params_from_json(fileDlg.filename)
        except:
            _ui.messageBox('Error (Import execute):\\n{}'.format(traceback.format_exc()))

class ExportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args: adsk.core.CommandEventArgs):
        try:
            fileDlg = _ui.createFileDialog()
            fileDlg.isMultiSelectEnabled = False
            fileDlg.title = 'Save Parameters to JSON'
            fileDlg.filter = 'JSON files (*.json)'
            if fileDlg.showSave() != adsk.core.DialogResults.DialogOK:
                return
            export_params_to_json(fileDlg.filename)
        except:
            _ui.messageBox('Error (Export execute):\\n{}'.format(traceback.format_exc()))

class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, execute_handler: adsk.core.CommandEventHandler):
        super().__init__()
        self._execute_handler = execute_handler
    def notify(self, args: adsk.core.CommandCreatedEventArgs):
        try:
            cmd = args.command
            cmd.execute.add(self._execute_handler)
            _handlers.append(self._execute_handler)  # keep alive
        except:
            _ui.messageBox('Error (commandCreated):\\n{}'.format(traceback.format_exc()))

def add_command(cmd_id, cmd_name, cmd_desc, execute_handler_cls):
    # Command definition
    cmdDef = _ui.commandDefinitions.itemById(cmd_id)
    if not cmdDef:
        cmdDef = _ui.commandDefinitions.addButtonDefinition(cmd_id, cmd_name, cmd_desc)

    # Hook created -> then hook execute
    onExecute = execute_handler_cls()
    onCreated = CommandCreatedHandler(onExecute)
    cmdDef.commandCreated.add(onCreated)
    _handlers.extend([onExecute, onCreated])

    # Put it on the standard Scripts & Add-Ins panel
    ws = _ui.workspaces.itemById('FusionSolidEnvironment')
    panel = ws.toolbarPanels.itemById('SolidScriptsAddinsPanel')
    if panel and not panel.controls.itemById(cmd_id):
        panel.controls.addCommand(cmdDef)

def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface

        add_command('FusionParamsImport', 'Import Params from JSON', 'Create/update user parameters from JSON', ImportParamsCommandExecuteHandler)
        add_command('FusionParamsExport', 'Export Params to JSON', 'Save current user parameters to JSON', ExportParamsCommandExecuteHandler)

    except:
        if _ui:
            _ui.messageBox('Add-in start failed:\\n{}'.format(traceback.format_exc()))

def stop(context):
    global _ui
    try:
        ws = _ui.workspaces.itemById('FusionSolidEnvironment')
        panel = ws.toolbarPanels.itemById('SolidScriptsAddinsPanel')
        for cmd_id in ['FusionParamsImport', 'FusionParamsExport']:
            # remove control
            if panel:
                ctrl = panel.controls.itemById(cmd_id)
                if ctrl: ctrl.deleteMe()
            # remove command definition
            cmd = _ui.commandDefinitions.itemById(cmd_id)
            if cmd: cmd.deleteMe()
    except:
        pass