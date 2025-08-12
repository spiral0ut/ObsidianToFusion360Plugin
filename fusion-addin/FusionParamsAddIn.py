# FusionParamsAddIn.py
# Minimal Fusion 360 add-in to import/export user parameters via JSON files.

import adsk.core, adsk.fusion, adsk.cam, traceback, json

_app = None
_ui = None
_handlers = []

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
        with design.rootComponent._parent._parent.beginUndoGroup('Apply Params from JSON'):
            for p in params:
                name = p.get('name')
                comment = p.get('comment')
                if 'expression' in p:
                    upsert_user_param(design.userParameters, name, p['expression'], '', comment)
                else:
                    val = p.get('value')
                    unit = p.get('unit', default_unit)
                    upsert_user_param(design.userParameters, name, val, unit, comment)
    except:
        _ui.messageBox('Failed to apply params:\n{}'.format(traceback.format_exc()))

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
            # If expression resolves to a constant with units, keep as expression string
            # Else store value+unit as best-effort
            out["parameters"].append({
                "name": p.name,
                "expression": p.expression,
                "comment": p.comment or ""
            })
        with open(path, 'w') as f:
            json.dump(out, f, indent=2)
        _ui.messageBox(f'Exported {len(out["parameters"])} parameters to:\n{path}')
    except:
        _ui.messageBox('Failed to export params:\n{}'.format(traceback.format_exc()))

class ImportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self): super().__init__()
    def notify(self, args):
        try:
            fileDlg = _ui.createFileDialog()
            fileDlg.isMultiSelectEnabled = False
            fileDlg.title = 'Select JSON Parameter File'
            fileDlg.filter = 'JSON files (*.json)'
            if fileDlg.showOpen() != adsk.core.DialogResults.DialogOK:
                return
            apply_params_from_json(fileDlg.filename)
        except:
            _ui.messageBox('Error:\n{}'.format(traceback.format_exc()))

class ExportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self): super().__init__()
    def notify(self, args):
        try:
            fileDlg = _ui.createFileDialog()
            fileDlg.isMultiSelectEnabled = False
            fileDlg.title = 'Save Parameters to JSON'
            fileDlg.filter = 'JSON files (*.json)'
            if fileDlg.showSave() != adsk.core.DialogResults.DialogOK:
                return
            export_params_to_json(fileDlg.filename)
        except:
            _ui.messageBox('Error:\n{}'.format(traceback.format_exc()))

def add_command(workspace, panel_id, cmd_id, cmd_name, cmd_desc, handler_cls):
    panel = workspace.toolbarPanels.itemById(panel_id)
    if not panel:
        panel = workspace.toolbarPanels.add(panel_id, 'Fusion Params', 'SelectPanel', False)
    cmdDef = _ui.commandDefinitions.itemById(cmd_id) or _ui.commandDefinitions.addButtonDefinition(cmd_id, cmd_name, cmd_desc)
    onExecute = handler_cls()
    cmdDef.commandCreated.add(lambda args: args.command.execute.add(onExecute))
    _handlers.append(onExecute)
    panel.controls.addCommand(cmdDef)

def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        ws = _ui.workspaces.itemById('FusionSolidEnvironment')
        add_command(ws, 'FusionParamsPanel', 'FusionParamsImport', 'Import Params from JSON', 'Create/update user parameters from JSON', ImportParamsCommandExecuteHandler)
        add_command(ws, 'FusionParamsPanel', 'FusionParamsExport', 'Export Params to JSON', 'Save current user parameters to JSON', ExportParamsCommandExecuteHandler)
    except:
        if _ui:
            _ui.messageBox('Add-in start failed:\n{}'.format(traceback.format_exc()))

def stop(context):
    global _ui
    try:
        # remove UI items
        ws = _ui.workspaces.itemById('FusionSolidEnvironment')
        panel = ws.toolbarPanels.itemById('FusionParamsPanel')
        if panel:
            for i in reversed(range(panel.controls.count)):
                c = panel.controls.item(i)
                if c and (c.id == 'FusionParamsImport' or c.id == 'FusionParamsExport'):
                    c.deleteMe()
            panel.deleteMe()
        for cmd_id in ['FusionParamsImport', 'FusionParamsExport']:
            cmd = _ui.commandDefinitions.itemById(cmd_id)
            if cmd: cmd.deleteMe()
    except:
        pass