const SHARECAPSULE_TEMPLATE_API = 'https://api.sharecapsule.app/api/v1/global-activities';

export function registerTaskRoutes({ app, db, admin, requireSession, requireAdmin, getGroupContext, normalizeEmail, validDate }) {
  app.get('/api/task-templates', requireSession, async (_req, res, next) => {
    try {
      const body = await fetchJson(SHARECAPSULE_TEMPLATE_API);
      const items = Array.isArray(body?.items) ? body.items : [];
      res.json({ ok: true, data: items.map(item => ({
        id: String(item.id || ''),
        title: String(item.title || 'Untitled checklist'),
        category: String(item.category || 'General'),
        taskCount: Number(item.task_count || item.taskCount || 0)
      })).filter(item => item.id) });
    } catch (error) { next(error); }
  });

  app.get('/api/task-templates/:templateId', requireSession, async (req, res, next) => {
    try {
      const board = await fetchTemplate(req.params.templateId);
      res.json({ ok: true, data: publicTemplate(board) });
    } catch (error) { next(error); }
  });

  app.get('/api/tasks/today', requireSession, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const date = resolveDate(req.query.date, validDate);
      const email = normalizeEmail(req.user.email);
      const tasks = await loadGroupTasks(db, context.group.id, date);
      const assigned = tasks.filter(task => taskAssignedTo(task, email));
      const statusRef = memberDayRef(db, context.group.id, date, email);
      const statusDoc = await statusRef.get();
      const completed = new Set(statusDoc.exists && Array.isArray(statusDoc.data()?.completedTaskIds) ? statusDoc.data().completedTaskIds : []);
      const result = assigned.map(task => ({ ...publicTask(task), completed: completed.has(task.id) }));
      const completedCount = result.filter(task => task.completed).length;
      res.json({ ok: true, data: {
        date,
        tasks: result,
        completedCount,
        totalCount: result.length,
        percent: result.length ? Math.round((completedCount / result.length) * 100) : 0
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/tasks/:taskId/completion', requireSession, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const date = resolveDate(req.body.date, validDate);
      const email = normalizeEmail(req.user.email);
      const completed = Boolean(req.body.completed);
      const taskRef = db.collection('groups').doc(context.group.id).collection('communityTasks').doc(String(req.params.taskId));
      const taskDoc = await taskRef.get();
      if (!taskDoc.exists) return res.status(404).json({ ok: false, error: 'Task not found' });
      const task = { id: taskDoc.id, ...taskDoc.data() };
      if (!taskAppliesOnDate(task, date) || !taskAssignedTo(task, email)) return res.status(403).json({ ok: false, error: 'This task is not assigned to you for this date' });

      const ref = memberDayRef(db, context.group.id, date, email);
      await ref.set({
        memberEmail: email,
        date,
        completedTaskIds: completed ? admin.firestore.FieldValue.arrayUnion(task.id) : admin.firestore.FieldValue.arrayRemove(task.id),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      res.json({ ok: true, data: { taskId: task.id, date, completed } });
    } catch (error) { next(error); }
  });

  app.get('/api/group/tasks/summary', requireSession, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const date = resolveDate(req.query.date, validDate);
      const [tasks, memberSnapshot, statusSnapshot] = await Promise.all([
        loadGroupTasks(db, context.group.id, date),
        db.collection('groups').doc(context.group.id).collection('members').get(),
        db.collection('groups').doc(context.group.id).collection('taskDays').doc(date).collection('members').get()
      ]);
      const statusByEmail = new Map(statusSnapshot.docs.map(doc => [normalizeEmail(doc.data()?.memberEmail || doc.id), new Set(Array.isArray(doc.data()?.completedTaskIds) ? doc.data().completedTaskIds : [])]));
      const members = memberSnapshot.docs
        .map(doc => ({ email: normalizeEmail(doc.data()?.email || doc.id), name: doc.data()?.name || doc.data()?.email || doc.id, status: doc.data()?.status || 'active' }))
        .filter(member => member.status !== 'disabled')
        .map(member => {
          const memberTasks = tasks.filter(task => taskAssignedTo(task, member.email));
          const completedIds = statusByEmail.get(member.email) || new Set();
          const completedCount = memberTasks.filter(task => completedIds.has(task.id)).length;
          return {
            email: member.email,
            name: member.name,
            completedCount,
            totalCount: memberTasks.length,
            percent: memberTasks.length ? Math.round((completedCount / memberTasks.length) * 100) : 0
          };
        });
      res.json({ ok: true, data: { date, members, tasks: tasks.map(publicTask) } });
    } catch (error) { next(error); }
  });

  app.post('/api/group/tasks/import', requireSession, requireAdmin, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const templateId = String(req.body.templateId || '').trim();
      if (!templateId) return res.status(400).json({ ok: false, error: 'templateId is required' });
      const startDate = resolveDate(req.body.startDate, validDate);
      const assignment = await normalizeAssignment(db, context.group.id, req.body.assignees, normalizeEmail);
      const board = await fetchTemplate(templateId);
      const template = publicTemplate(board);
      if (!template.tasks.length) return res.status(400).json({ ok: false, error: 'The selected checklist does not contain tasks' });

      const taskCollection = db.collection('groups').doc(context.group.id).collection('communityTasks');
      const existingSnapshot = await taskCollection.get();
      const existingKeys = new Set(existingSnapshot.docs.map(doc => taskIdentity(doc.data())));
      const batch = db.batch();
      let created = 0;
      let skipped = 0;
      template.tasks.forEach((sourceTask, index) => {
        const identity = taskIdentity({ sourceTemplateId: template.id, title: sourceTask.title, startDate, assignmentMode: assignment.mode, assignees: assignment.assignees });
        if (existingKeys.has(identity)) { skipped += 1; return; }
        const ref = taskCollection.doc();
        batch.set(ref, {
          title: sourceTask.title,
          priority: normalizePriority(sourceTask.priority),
          source: template.title,
          sourceTemplateId: template.id,
          sourceCategory: template.category,
          recurrence: 'daily',
          startDate,
          endDate: null,
          assignmentMode: assignment.mode,
          assignees: assignment.assignees,
          sortOrder: index,
          createdBy: req.user.email,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        existingKeys.add(identity);
        created += 1;
      });
      if (created) await batch.commit();
      res.status(created ? 201 : 200).json({ ok: true, data: { template: { id: template.id, title: template.title }, created, skipped, startDate, assignmentMode: assignment.mode, assignees: assignment.assignees } });
    } catch (error) { next(error); }
  });

  app.post('/api/group/tasks', requireSession, requireAdmin, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const title = String(req.body.title || '').trim().slice(0, 180);
      if (!title) return res.status(400).json({ ok: false, error: 'Task title is required' });
      const startDate = resolveDate(req.body.startDate, validDate);
      const assignment = await normalizeAssignment(db, context.group.id, req.body.assignees, normalizeEmail);
      const ref = db.collection('groups').doc(context.group.id).collection('communityTasks').doc();
      await ref.set({
        title,
        priority: normalizePriority(req.body.priority),
        source: 'Community activity',
        sourceTemplateId: null,
        sourceCategory: 'Custom',
        recurrence: 'daily',
        startDate,
        endDate: null,
        assignmentMode: assignment.mode,
        assignees: assignment.assignees,
        sortOrder: 0,
        createdBy: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(201).json({ ok: true, data: { id: ref.id, title, startDate, assignmentMode: assignment.mode, assignees: assignment.assignees } });
    } catch (error) { next(error); }
  });

  app.delete('/api/group/tasks/:taskId', requireSession, requireAdmin, async (req, res, next) => {
    try {
      const context = await getGroupContext(req.user.sub);
      const endDate = resolveDate(req.body?.endDate || req.query.endDate, validDate);
      const ref = db.collection('groups').doc(context.group.id).collection('communityTasks').doc(String(req.params.taskId));
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'Task not found' });
      await ref.set({ endDate, endedBy: req.user.email, endedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true, data: { taskId: doc.id, endDate } });
    } catch (error) { next(error); }
  });
}

async function fetchTemplate(templateId) {
  const id = encodeURIComponent(String(templateId || '').trim());
  if (!id) throw Object.assign(new Error('Checklist template is required'), { statusCode: 400 });
  return fetchJson(`${SHARECAPSULE_TEMPLATE_API}/${id}`);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`ShareCapsule checklist service returned ${response.status}`), { statusCode: 502 });
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('ShareCapsule checklist service timed out'), { statusCode: 504 });
    throw error;
  } finally { clearTimeout(timeout); }
}

function publicTemplate(board) {
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  return {
    id: String(board?.id || ''),
    title: String(board?.title || 'Untitled checklist'),
    category: String(board?.category || 'General'),
    tasks: tasks.map(task => ({ title: String(task?.title || '').trim().slice(0, 180), priority: normalizePriority(task?.priority) })).filter(task => task.title)
  };
}

async function normalizeAssignment(db, groupId, rawAssignees, normalizeEmail) {
  if (!Array.isArray(rawAssignees) || rawAssignees.length === 0 || rawAssignees.includes('*')) return { mode: 'all', assignees: [] };
  const requested = [...new Set(rawAssignees.map(normalizeEmail).filter(Boolean))];
  const snapshot = await db.collection('groups').doc(groupId).collection('members').get();
  const memberEmails = new Set(snapshot.docs.map(doc => normalizeEmail(doc.data()?.email || doc.id)));
  const invalid = requested.filter(email => !memberEmails.has(email));
  if (invalid.length) throw Object.assign(new Error(`These assignees are not group members: ${invalid.join(', ')}`), { statusCode: 400 });
  return { mode: 'selected', assignees: requested };
}

async function loadGroupTasks(db, groupId, date) {
  const snapshot = await db.collection('groups').doc(groupId).collection('communityTasks').get();
  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(task => taskAppliesOnDate(task, date))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.title || '').localeCompare(String(b.title || '')));
}

function taskAppliesOnDate(task, date) {
  const startDate = String(task.startDate || '0000-00-00');
  const endDate = task.endDate ? String(task.endDate) : null;
  return startDate <= date && (!endDate || date <= endDate);
}

function taskAssignedTo(task, email) {
  return task.assignmentMode !== 'selected' || (Array.isArray(task.assignees) && task.assignees.map(String).map(value => value.toLowerCase()).includes(String(email).toLowerCase()));
}

function memberDayRef(db, groupId, date, email) {
  return db.collection('groups').doc(groupId).collection('taskDays').doc(date).collection('members').doc(email);
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    priority: normalizePriority(task.priority),
    source: task.source || 'Community activity',
    category: task.sourceCategory || 'Custom',
    recurrence: task.recurrence || 'daily',
    startDate: task.startDate,
    endDate: task.endDate || null,
    assignmentMode: task.assignmentMode || 'all',
    assignees: Array.isArray(task.assignees) ? task.assignees : []
  };
}

function resolveDate(value, validDate) {
  const candidate = String(value || '');
  return validDate(candidate) ? candidate : new Date().toISOString().slice(0, 10);
}

function normalizePriority(value) {
  const priority = String(value || 'medium').toLowerCase();
  return ['high', 'medium', 'low', 'none'].includes(priority) ? priority : 'medium';
}

function priorityRank(value) { return { high: 0, medium: 1, low: 2, none: 3 }[normalizePriority(value)] ?? 3; }

function taskIdentity(task) {
  const assignees = Array.isArray(task.assignees) ? [...task.assignees].sort().join('|') : '';
  return `${String(task.sourceTemplateId || 'custom').toLowerCase()}::${String(task.title || '').trim().toLowerCase()}::${String(task.startDate || '')}::${String(task.assignmentMode || 'all')}::${assignees}`;
}
