/**
 * Interaction QA for the Projects sidebar harness: opens menus, dialogs,
 * search, collapse, new-conversation and project-creation flows, captures
 * screenshots and asserts the observable result. Browser console errors are
 * failures.
 *
 * Usage: node harness/qa.mjs [name-substring]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'harness/shots')
await mkdir(shots, { recursive: true })
const base = pathToFileURL(join(root, 'harness/index.html')).href

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const browser = await chromium.launch({ channel: 'chrome' })

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${base}?${query}`)
  await page.waitForFunction(
    () => document.body.dataset.ready === '1' || document.body.dataset.error !== undefined,
    undefined,
    { timeout: 20_000 },
  )
  const harnessError = await page.evaluate(() => document.body.dataset.error ?? null)
  check(harnessError === null, `[${query}] harness error: ${harnessError}`)
  await page.waitForTimeout(120)
  return { page, errors }
}

async function shot(page, name) {
  await page.waitForTimeout(180)
  await page.screenshot({ path: join(shots, `${name}.png`) })
  console.log('shot', name)
}

async function menuLabels(page) {
  const items = await page
    .locator('.pj-menu [role="menuitem"], .pj-menu [role="menuitemcheckbox"], .pj-menu .pj-menu-heading')
    .allInnerTexts()
  return items.map((label) => label.replace(/\n/g, ' ').trim())
}

// ── default wide: row hover, session menu, project menu, view menu ─────────
{
  const { page, errors } = await open('theme=light&wide=1')
  const row = page.locator('.pj-session').first()
  await row.hover()
  await shot(page, 'qa-01-row-hover')
  const actionsVisible = await row.locator('.pj-session-actions').evaluate((el) => getComputedStyle(el).display !== 'none')
  check(actionsVisible, 'session actions should be visible on hover')

  await row.locator('.pj-session-actions button').click()
  await page.waitForSelector('.pj-menu')
  const sessionMenu = await menuLabels(page)
  console.log('session menu:', JSON.stringify(sessionMenu))
  for (const expected of ['打开', '重命名', '分叉会话', '归档会话']) {
    check(sessionMenu.some((label) => label.includes(expected)), `session menu misses ${expected}: ${JSON.stringify(sessionMenu)}`)
  }
  await shot(page, 'qa-02-session-menu')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  check((await page.locator('.pj-menu').count()) === 0, 'Escape should close the session menu')

  const projectHeader = page.locator('.pj-section .pj-group-header').first()
  await projectHeader.hover()
  await shot(page, 'qa-03-project-hover')
  await projectHeader.locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  const projectMenu = await menuLabels(page)
  console.log('project menu:', JSON.stringify(projectMenu))
  check(projectMenu.some((label) => label.includes('新建会话')), 'project menu misses new conversation')
  check(projectMenu.some((label) => label.includes('添加文件夹')), 'project menu misses add folder')
  await shot(page, 'qa-04-project-menu')
  await page.keyboard.press('Escape')

  await page.locator('.pj-header-actions').locator('button').nth(1).click()
  await page.waitForSelector('.pj-menu')
  const viewMenu = await menuLabels(page)
  console.log('view menu:', JSON.stringify(viewMenu))
  check(viewMenu.some((label) => label.includes('显示已归档会话')), 'view menu misses archived toggle')
  await shot(page, 'qa-05-view-menu')
  await page.keyboard.press('Escape')

  check(errors.length === 0, `default scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── compatibility with sidebar-decorating host plugins ────────────────────
// dsh-timeline and similar plugins resolve our rows through the shipped DOM
// contract (`div[role="treeitem"][aria-selected]` inside the workspaces slot),
// find the title as the first text-bearing button-free child, and inject menu
// items into a host menu mounted as `body > [role="menu"]`.
{
  const { page, errors } = await open('theme=light&wide=1')
  const compat = await page.evaluate(() => {
    const hole = document.querySelector('[data-slot="sidebar.workspaces"]')
    const rows = hole === null ? [] : [...hole.querySelectorAll('div[role="treeitem"][aria-selected]')]
    const findTitleEl = (row) => {
      for (const child of row.children) {
        if (!(child instanceof HTMLElement)) continue
        if (child.querySelector('button') !== null) continue
        if ((child.textContent ?? '').trim() === '') continue
        return child
      }
      return null
    }
    return {
      rowCount: rows.length,
      sessionRowCount: document.querySelectorAll('.pj-session').length,
      titles: rows.slice(0, 4).map((row) => findTitleEl(row)?.textContent?.trim() ?? null),
      listRole: document.querySelector('.pj-list')?.getAttribute('role') ?? null,
    }
  })
  console.log('timeline DOM protocol:', JSON.stringify(compat))
  check(compat.listRole === 'tree', 'list container should expose role=tree')
  check(compat.rowCount > 0 && compat.rowCount === compat.sessionRowCount, `every session row must resolve as div[role=treeitem][aria-selected] (${compat.rowCount}/${compat.sessionRowCount})`)
  check(compat.titles.every((title) => title !== null && title !== ''), `timeline title resolution failed: ${JSON.stringify(compat.titles)}`)

  // open a session menu and emulate timeline's body-portal menu injection
  const targetRow = page.locator('.pj-session').filter({ hasText: '重写项目侧栏' }).first()
  await targetRow.hover()
  await targetRow.locator('.pj-session-actions button').click()
  await page.waitForSelector('.pj-menu')
  const menuCompat = await page.evaluate(() => {
    const menus = document.querySelectorAll('body > [role="menu"]')
    const menu = menus[menus.length - 1] ?? null
    if (menu === null) return { menuCount: 0 }
    const items = menu.querySelectorAll('[role="menuitem"]')
    const first = items[0]
    const wrap = first instanceof HTMLElement ? first.parentElement : null
    const clone = wrap === null ? null : wrap.cloneNode(true)
    const btn = clone instanceof HTMLElement ? clone.querySelector('[role="menuitem"]') : null
    const spans = btn === null ? [] : [...btn.querySelectorAll('span')]
    let injected = false
    if (clone instanceof HTMLElement && wrap !== null && wrap.parentElement !== null) {
      clone.setAttribute('data-test-timeline-item', '')
      wrap.parentElement.insertBefore(clone, wrap.nextElementSibling)
      injected = true
    }
    const nestedMenu = document.querySelector('[data-slot="sidebar.workspaces"] [role="menu"]')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return {
      menuCount: menus.length,
      itemCount: items.length,
      hasWrap: wrap !== null,
      cloneOk: btn !== null,
      spanCount: spans.length,
      injected,
      nestedMenu: nestedMenu !== null,
    }
  })
  console.log('timeline menu protocol:', JSON.stringify(menuCompat))
  check(menuCompat.menuCount >= 1 && menuCompat.nestedMenu === false, 'menu must be a direct child of body (body > [role=menu])')
  check(menuCompat.itemCount >= 2 && menuCompat.hasWrap, 'menu needs role=menuitem items inside wrappers for host injection')
  check(menuCompat.cloneOk && menuCompat.spanCount >= 2, 'host menu-item clones must expose icon span + label span')
  check(menuCompat.injected, 'timeline-style menu item injection should succeed')
  await page.waitForTimeout(250)
  const stillOpen = await page.evaluate(() => document.querySelectorAll('body > [role="menu"]').length)
  check(stillOpen === 0, 'Escape must close the portaled menu (host plugins dispatch Escape to close it)')
  await shot(page, 'qa-24-plugin-compat')
  check(errors.length === 0, `plugin compatibility scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── new project dialog (light + dark) and creation flow ────────────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  await page.locator('.pj-header-actions').locator('button').first().click()
  await page.waitForSelector('.pj-modal')
  await shot(page, 'qa-06-new-project-dialog')
  const input = page.locator('.pj-modal input').first()
  await input.fill('我的新项目')
  const swatches = page.locator('.pj-modal [aria-label^="颜色"]')
  if ((await swatches.count()) > 1) await swatches.nth(3).click()
  await shot(page, 'qa-07-new-project-filled')
  const submit = page.locator('.pj-modal-footer button').last()
  await submit.click()
  await page.waitForTimeout(300)
  check((await page.locator('.pj-modal').count()) === 0, 'new project dialog should close after submit')
  const projectNames = await page.locator('.pj-section .pj-group-title').allInnerTexts()
  console.log('projects after create:', JSON.stringify(projectNames))
  check(projectNames.includes('我的新项目'), `created project missing in sidebar: ${JSON.stringify(projectNames)}`)
  await shot(page, 'qa-08-project-created')
  check(errors.length === 0, `create scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── search, collapse, multi-directory chooser, new conversation ────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  await page.locator('.pj-search button').first().click()
  await page.locator('.pj-search-input').fill('LLM')
  await page.waitForTimeout(250)
  const results = await page.locator('.pj-session').count()
  console.log('search results:', results)
  check(results > 0, 'search should show matching sessions')
  await shot(page, 'qa-09-search-results')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check((await page.locator('.pj-search-input').count()) === 0, 'Escape should collapse search')

  // collapse the first project section
  const firstProjectHeader = page.locator('.pj-section .pj-group-header').first()
  const beforeRows = await page.locator('.pj-section').first().locator('.pj-session').count()
  await firstProjectHeader.click()
  await page.waitForTimeout(150)
  const afterRows = await page.locator('.pj-section').first().locator('.pj-session').count()
  check(beforeRows > 0 && afterRows === 0, `collapsing a project should hide its rows (${beforeRows} -> ${afterRows})`)
  await shot(page, 'qa-10-project-collapsed')
  await firstProjectHeader.click()

  // 研究项目 has two directories -> its project menu's "新建会话" opens the chooser
  const researchHeader = page.locator('.pj-section .pj-group-header').filter({ hasText: '研究项目' })
  await researchHeader.hover()
  await researchHeader.locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '新建会话' }).first().click()
  let dirMenu = []
  try {
    await page.waitForFunction(
      () => (document.querySelector('.pj-menu')?.textContent ?? '').includes('选择工作目录'),
      undefined,
      { timeout: 3_000 },
    )
    dirMenu = await menuLabels(page)
    console.log('directory chooser:', JSON.stringify(dirMenu))
    check(dirMenu.some((label) => label.includes('Badstuff/Hoard')), `chooser misses the Hoard directory: ${JSON.stringify(dirMenu)}`)
    check(dirMenu.some((label) => label.includes('Badstuff/LLM')), `chooser misses the LLM directory: ${JSON.stringify(dirMenu)}`)
    check(dirMenu.some((label) => label.includes('选择其他目录')), `chooser misses the other-directory item: ${JSON.stringify(dirMenu)}`)
    await shot(page, 'qa-11-directory-chooser')
    await page.keyboard.press('Escape')
  } catch {
    failures.push('project menu "新建会话" for a multi-directory project did not open the directory chooser')
    await page.keyboard.press('Escape')
  }

  // single-directory project + creates a conversation immediately
  const desktopHeader = page.locator('.pj-section .pj-group-header').filter({ hasText: '桌面端改造' })
  await desktopHeader.hover()
  const rowsBefore = await page.locator('.pj-session').count()
  await desktopHeader.locator('.pj-group-actions button').first().click()
  await page.waitForTimeout(400)
  const rowsAfter = await page.locator('.pj-session').count()
  console.log('new conversation rows:', rowsBefore, '->', rowsAfter)
  check(rowsAfter === rowsBefore + 1, 'new conversation should add one session row')
  await shot(page, 'qa-12-after-new-conversation')
  check(errors.length === 0, `interaction scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── submenus, rename, running-archive confirm, archived filter ─────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  const target = page.locator('.pj-session').filter({ hasText: '重写项目侧栏' }).first()

  async function openSessionMenu() {
    await target.hover()
    await target.locator('.pj-session-actions button').click()
    await page.waitForSelector('.pj-menu')
  }

  // move-to-project submenu
  await openSessionMenu()
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '移动到项目' }).click()
  await page.waitForFunction(
    () => (document.querySelector('.pj-menu')?.textContent ?? '').includes('不归入任何项目'),
    undefined,
    { timeout: 4_000 },
  )
  const assignMenu = await menuLabels(page)
  console.log('assign submenu:', JSON.stringify(assignMenu))
  check(assignMenu.some((label) => label.includes('课程作业')), `assign submenu misses projects: ${JSON.stringify(assignMenu)}`)
  await shot(page, 'qa-18-assign-submenu')
  await page.keyboard.press('Escape')

  // change-working-directory chooser
  await openSessionMenu()
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '更改工作目录' }).click()
  await page.waitForFunction(
    () => (document.querySelector('.pj-menu')?.textContent ?? '').includes('选择工作目录'),
    undefined,
    { timeout: 4_000 },
  )
  const dirMenu = await menuLabels(page)
  console.log('session dir chooser:', JSON.stringify(dirMenu))
  check(dirMenu.some((label) => label.includes('选择其他目录')), `session dir chooser misses other item: ${JSON.stringify(dirMenu)}`)
  await shot(page, 'qa-19-session-dir-menu')
  await page.keyboard.press('Escape')

  // rename session through the dialog
  await openSessionMenu()
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '重命名' }).click()
  await page.waitForSelector('.pj-modal')
  const renameInput = page.locator('.pj-modal input').first()
  await renameInput.fill('重写后的标题')
  await shot(page, 'qa-20-rename-dialog')
  await page.locator('.pj-modal-footer button').last().click()
  await page.waitForTimeout(250)
  check((await page.locator('.pj-session', { hasText: '重写后的标题' }).count()) > 0, 'renamed session title should appear in the sidebar')
  await page.waitForTimeout(150)

  // archive the running session -> stop-and-archive confirmation
  const renamed = page.locator('.pj-session').filter({ hasText: '重写后的标题' }).first()
  await renamed.hover()
  await renamed.locator('.pj-session-actions button').click()
  await page.waitForSelector('.pj-menu')
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '归档会话' }).click()
  await page.waitForSelector('.pj-modal')
  const dialogText = await page.locator('.pj-modal').innerText()
  check(dialogText.includes('停止并归档'), `running-archive dialog should offer stop-and-archive: ${dialogText}`)
  await shot(page, 'qa-21-archive-running-confirm')
  await page.locator('.pj-modal button', { hasText: '停止并归档' }).click()
  await page.waitForTimeout(350)
  check((await page.locator('.pj-session', { hasText: '重写后的标题' }).count()) === 0, 'archived session should disappear from the default filter')
  check((await page.locator('[data-pj-toast], .pj-toast').count()) > 0, 'archive success should show a toast')
  await shot(page, 'qa-22-archive-toast')

  // archived filter reveals archived sessions
  await page.locator('.pj-header-actions').locator('button').nth(1).click()
  await page.waitForSelector('.pj-menu')
  await page.locator('.pj-menu [role="menuitemcheckbox"]', { hasText: '显示已归档会话' }).click()
  await page.waitForTimeout(250)
  check((await page.locator('.pj-session', { hasText: '旧会话 A' }).count()) > 0, 'archived sessions should appear after enabling the filter')
  await shot(page, 'qa-23-show-archived')
  check(errors.length === 0, `submenu/archive scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── stale blank sessions: hidden from the tree + bulk cleanup ──────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pj-session').length,
    blankRows: [...document.querySelectorAll('.pj-session')]
      .filter((row) => (row.textContent || '').includes('新会话')).length,
    archived: (window.__mocks?.workspaces.getSnapshot().archivedSessionIds ?? []).slice(),
  }))
  console.log('blank filtering:', JSON.stringify(before))
  check(before.blankRows === 0, `stale blank sessions must be hidden from the tree (${before.blankRows} visible)`)
  check(before.rows === 13, `expected 13 content-bearing rows, saw ${before.rows}`)

  // view options -> cleanup entry with the hidden blank count
  await page.locator('.pj-header-actions').locator('button').nth(1).click()
  await page.waitForSelector('.pj-menu')
  const cleanupItem = page.locator('body > [role="menu"] [role="menuitem"]', { hasText: '删除空会话' }).first()
  check((await cleanupItem.count()) === 1, 'view menu should offer empty-conversation cleanup')
  const cleanupLabel = await cleanupItem.innerText()
  check(cleanupLabel.includes('3'), `cleanup label should name 3 stale blanks: ${cleanupLabel}`)
  await shot(page, 'qa-25-view-cleanup')
  await cleanupItem.click()
  await page.waitForSelector('[role="dialog"]')
  const dialogText = await page.locator('[role="dialog"]').innerText()
  check(dialogText.includes('3'), `cleanup dialog should name the count: ${dialogText.replace(/\n/g, ' ')}`)
  check(dialogText.includes('彻底删除'), `cleanup dialog should say it really deletes: ${dialogText.replace(/\n/g, ' ')}`)
  await shot(page, 'qa-26-cleanup-dialog')
  await page.locator('[role="dialog"] button', { hasText: '彻底删除' }).click()
  await page.waitForTimeout(900)
  const toastText = await page.locator('.pj-toast').allInnerTexts().catch(() => [])
  console.log('cleanup toast:', JSON.stringify(toastText))
  check(toastText.some((text) => text.includes('彻底删除') && text.includes('3')), `cleanup should toast the purged count: ${JSON.stringify(toastText)}`)
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pj-session').length,
    archived: (window.__mocks?.workspaces.getSnapshot().archivedSessionIds ?? []).slice(),
    blankIds: (window.__mocks?.sessions.getSnapshot().ids ?? []).filter((id) => {
      const row = window.__mocks.sessions.getSnapshot().byId[id]
      return row?.blank === true
    }),
  }))
  console.log('after cleanup:', JSON.stringify(after))
  check(after.blankIds.length === 0, `blank sessions should be gone from the catalog (${JSON.stringify(after.blankIds)})`)
  check(after.rows === 13, 'content-bearing rows must not change during cleanup')
  // the cleanup entry disappears once no stale blanks remain
  await page.locator('.pj-header-actions').locator('button').nth(1).click()
  await page.waitForSelector('.pj-menu')
  const remaining = await page.locator('body > [role="menu"] [role="menuitem"]', { hasText: '删除空会话' }).count()
  check(remaining === 0, 'cleanup entry should disappear when nothing is left to clean')
  await page.keyboard.press('Escape')
  check(errors.length === 0, `blank cleanup scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── migration: drag / menu between projects ────────────────────────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  const headerOf = (name) => page.locator('.pj-section').filter({ hasText: name }).locator('.pj-group-header').first()
  const titlesIn = async (name) =>
    page.locator('.pj-section').filter({ hasText: name }).locator('.pj-session-title').allInnerTexts()

  // 1) drag one ungrouped conversation onto a project
  const sessionRow = page.locator('.pj-session').filter({ hasText: '杂项会话' }).first()
  await sessionRow.dragTo(headerOf('课程作业'))
  await page.waitForTimeout(700)
  check((await titlesIn('课程作业')).includes('杂项会话'), 'dragging a session onto a project should move it there')
  let toast = await page.locator('.pj-toast').allInnerTexts().catch(() => [])
  check(toast.some((text) => text.includes('课程作业')), `session drop toast missing: ${JSON.stringify(toast)}`)
  await shot(page, 'qa-28-drag-session-dropped')

  // 2) drag a whole workspace group onto another project
  const softwareGroup = page.locator('.pj-group').filter({ hasText: 'Software' }).first()
  await softwareGroup.locator('.pj-group-header').first().dragTo(headerOf('桌面端改造'))
  await page.waitForTimeout(900)
  const desktopTitles = await titlesIn('桌面端改造')
  check(desktopTitles.includes('实验笔记') && desktopTitles.includes('杂项会话'), `workspace drag should move all its sessions: ${JSON.stringify(desktopTitles)}`)
  check((await page.locator('.pj-other-section .pj-group').filter({ hasText: 'Software' }).count()) === 0, 'moved workspace group should leave Other conversations')
  toast = await page.locator('.pj-toast').allInnerTexts().catch(() => [])
  check(toast.some((text) => text.includes('工作区') && text.includes('桌面端改造')), `workspace drop toast missing: ${JSON.stringify(toast)}`)
  const stateAfterWs = await page.evaluate(() => ({
    project: window.__mocks.projectData().projects.find((project) => project.name === '桌面端改造'),
    assignments: window.__mocks.projectData().assignments,
  }))
  check(
    stateAfterWs.project.directories.some((directory) => directory.endsWith('/Software')),
    `project directories should gain the workspace path: ${JSON.stringify(stateAfterWs.project.directories)}`,
  )
  await shot(page, 'qa-29-drag-workspace-dropped')

  // nested workspace group keeps its title inside the project
  const desktopSection = page.locator('.pj-section').filter({ hasText: '桌面端改造' })
  const nestedSoftware = desktopSection.locator('.pj-group-nested').filter({ hasText: 'Software' }).first()
  check((await nestedSoftware.count()) === 1, 'migrated workspace should stay visible as a titled group inside the project')
  check((await desktopSection.locator('.pj-group-nested .pj-session-title').allInnerTexts()).includes('实验笔记'), 'nested workspace group should hold its conversations')
  await shot(page, 'qa-34-nested-workspace-group')

  // 3a) rename the nested workspace through its menu
  await nestedSoftware.locator('.pj-group-header').first().hover()
  await nestedSoftware.locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  const nestedMenu = await menuLabels(page)
  check(nestedMenu.some((label) => label.includes('重命名工作区')), `nested workspace menu misses rename: ${JSON.stringify(nestedMenu)}`)
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '重命名工作区' }).click()
  await page.waitForSelector('[role="dialog"]')
  await page.locator('[role="dialog"] input').first().fill('软件工作区')
  await page.locator('[role="dialog"] button', { hasText: '保存' }).click()
  await page.waitForTimeout(700)
  check(
    (await desktopSection.locator('.pj-group-nested').filter({ hasText: '软件工作区' }).count()) === 1,
    'renaming a workspace should update the nested group title',
  )
  await shot(page, 'qa-35-workspace-renamed')

  // 3b) delete the nested workspace: registration goes away, sessions return to Other
  const renamedGroup = desktopSection.locator('.pj-group-nested').filter({ hasText: '软件工作区' }).first()
  await renamedGroup.locator('.pj-group-header').first().hover()
  await renamedGroup.locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '删除工作区' }).click()
  await page.waitForSelector('[role="dialog"]')
  const deleteDialog = await page.locator('[role="dialog"]').innerText()
  check(deleteDialog.includes('其他会话'), `delete-workspace dialog should explain where sessions go: ${deleteDialog.replace(/\n/g, ' ')}`)
  await page.locator('[role="dialog"] button', { hasText: '删除工作区' }).click()
  await page.waitForTimeout(900)
  check(
    (await page.locator('.pj-section').filter({ hasText: '桌面端改造' }).locator('.pj-group-nested').filter({ hasText: '软件工作区' }).count()) === 0,
    'deleted workspace should leave the project',
  )
  check(
    (await page.locator('.pj-other-section .pj-group').filter({ hasText: 'Software' }).count()) >= 1,
    'deleted workspace conversations should return under Other conversations',
  )
  const afterDelete = await page.evaluate(() => ({
    workspaceTitles: (window.__mocks?.workspaces.getSnapshot().items ?? []).map((item) => item.title),
    researchDirs: window.__mocks.projectData().projects.find((project) => project.name === '桌面端改造').directories,
  }))
  check(!afterDelete.workspaceTitles.includes('软件工作区'), `deleted workspace registration should be gone: ${JSON.stringify(afterDelete.workspaceTitles)}`)
  check(
    !afterDelete.researchDirs.some((directory) => directory.endsWith('/Software')),
    `deleted workspace directory should leave the project: ${JSON.stringify(afterDelete.researchDirs)}`,
  )
  await shot(page, 'qa-36-workspace-deleted')

  // 3) move a conversation from one project to another by dragging
  const movedRow = page.locator('.pj-section').filter({ hasText: '桌面端改造' }).locator('.pj-session').filter({ hasText: '重写项目侧栏' }).first()
  await movedRow.dragTo(headerOf('研究项目'))
  await page.waitForTimeout(700)
  check((await titlesIn('研究项目')).includes('重写项目侧栏'), 'dragging a session between projects should move it')
  await shot(page, 'qa-30-project-to-project')

  // 4) non-drag path: workspace group menu -> target project
  const downloadsGroup = page.locator('.pj-group').filter({ hasText: 'Downloads' }).first()
  await downloadsGroup.hover()
  await downloadsGroup.locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  const wsMenu = await menuLabels(page)
  console.log('workspace actions menu:', JSON.stringify(wsMenu))
  check(wsMenu.some((label) => label.includes('移动工作区到项目')), `workspace menu misses move item: ${JSON.stringify(wsMenu)}`)
  check(wsMenu.some((label) => label.includes('删除工作区')), `workspace menu misses delete item: ${JSON.stringify(wsMenu)}`)
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '移动工作区到项目' }).click()
  await page.waitForFunction(
    () => (document.querySelector('body > [role="menu"]')?.textContent ?? '').includes('移动到项目'),
    undefined,
    { timeout: 4_000 },
  )
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '研究项目' }).first().click()
  await page.waitForTimeout(800)
  check((await titlesIn('研究项目')).includes('下载目录会话'), 'workspace menu migration should move the directory sessions')
  check((await page.locator('.pj-other-section .pj-group').filter({ hasText: 'Downloads' }).count()) === 0, 'menu-migrated workspace should leave Other conversations')
  await shot(page, 'qa-31-workspace-menu-migration')

  // 5) move a working directory from project A to project B through the menus
  await headerOf('研究项目').hover()
  await headerOf('研究项目').locator('.pj-group-actions button').last().click()
  await page.waitForSelector('.pj-menu')
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '移动工作目录到其他项目' }).click()
  await page.waitForFunction(
    () => (document.querySelector('body > [role="menu"]')?.textContent ?? '').includes('选择要移动的工作目录'),
    undefined,
    { timeout: 4_000 },
  )
  const dirPick = await menuLabels(page)
  console.log('project dir picker:', JSON.stringify(dirPick))
  check(dirPick.some((label) => label.includes('Hoard')), `project dir picker misses Hoard: ${JSON.stringify(dirPick)}`)
  await page.locator('.pj-menu [role="menuitem"]', { hasText: 'Hoard' }).first().click()
  await page.waitForFunction(
    () => (document.querySelector('body > [role="menu"]')?.textContent ?? '').includes('移出项目'),
    undefined,
    { timeout: 4_000 },
  )
  const dirTarget = await menuLabels(page)
  console.log('project dir target:', JSON.stringify(dirTarget))
  await page.locator('.pj-menu [role="menuitem"]', { hasText: '课程作业' }).first().click()
  await page.waitForTimeout(900)
  check((await titlesIn('课程作业')).includes('Hoard 数据整理'), 'moving a working directory between projects should move its sessions')
  const stateAfterDirMove = await page.evaluate(() => ({
    research: window.__mocks.projectData().projects.find((project) => project.name === '研究项目'),
    homework: window.__mocks.projectData().projects.find((project) => project.name === '课程作业'),
  }))
  check(
    !stateAfterDirMove.research.directories.some((directory) => directory.endsWith('/Hoard')),
    `source project should drop the moved directory: ${JSON.stringify(stateAfterDirMove.research.directories)}`,
  )
  check(
    stateAfterDirMove.homework.directories.some((directory) => directory.endsWith('/Hoard')),
    `target project should gain the moved directory: ${JSON.stringify(stateAfterDirMove.homework.directories)}`,
  )
  await shot(page, 'qa-33-project-dir-migration')
  check(errors.length === 0, `migration scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── header affordances: chevron must not stick + project glyph ─────────────
{
  const { page, errors } = await open('theme=light&wide=1')
  const glyphs = await page.evaluate(() => document.querySelectorAll('.pj-project-glyph svg[data-pj-icon="project"]').length)
  check(glyphs >= 1, `project headers should use the layered project glyph (${glyphs})`)

  const header = page.locator('.pj-section .pj-group-header').first()
  await header.click()
  await page.mouse.move(4, 4)
  await page.waitForTimeout(250)
  const chevronDisplay = await header.evaluate((el) => {
    const chevron = el.querySelector('.pj-chevron')
    return chevron === null ? 'missing' : getComputedStyle(chevron).display
  })
  check(chevronDisplay === 'none', `group chevron must not stick after a mouse click (display=${chevronDisplay})`)
  await shot(page, 'qa-37-header-affordances')
  await header.click()
  check(errors.length === 0, `header affordance scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── legacy empty logs: hidden by the Host scan + deletable ────────────────
{
  const { page, errors } = await open('scenario=legacy&theme=light&wide=1')
  await page.waitForTimeout(600)
  const titles = await page.locator('.pj-session-title').allInnerTexts()
  console.log('legacy scenario titles:', JSON.stringify(titles.slice(0, 12)))
  check(!titles.includes('Badstuff'), `legacy empty sessions must be hidden after the scan: ${JSON.stringify(titles)}`)
  check(titles.includes('真实内容会话'), 'content sessions must stay visible')

  await page.locator('.pj-header-actions').locator('button').nth(1).click()
  await page.waitForSelector('.pj-menu')
  const cleanupItem = page.locator('body > [role="menu"] [role="menuitem"]', { hasText: '删除空会话' }).first()
  check((await cleanupItem.count()) === 1, 'cleanup entry should exist for scanned legacy empties')
  const label = await cleanupItem.innerText()
  check(label.includes('5'), `cleanup should count blanks + legacy empties: ${label}`)
  await shot(page, 'qa-38-legacy-hidden')
  await cleanupItem.click()
  await page.waitForSelector('[role="dialog"]')
  await page.locator('[role="dialog"] button', { hasText: '彻底删除' }).click()
  await page.waitForTimeout(1000)
  const after = await page.evaluate(() => ({
    ids: window.__mocks.sessions.getSnapshot().ids,
    toast: [...document.querySelectorAll('.pj-toast')].map((el) => el.textContent),
    emptyTitles: [...document.querySelectorAll('.pj-session-title')].map((el) => el.textContent).filter((text) => text === 'Badstuff'),
  }))
  console.log('legacy after purge:', JSON.stringify(after))
  check(!after.ids.includes('s20') && !after.ids.includes('s21'), 'legacy empty sessions should be deleted')
  check(after.ids.includes('s22'), 'content session must not be deleted')
  check(after.emptyTitles.length === 0, 'no legacy empty rows should remain')
  check(after.toast.some((text) => text.includes('5')), `purge toast should report 5 sessions: ${JSON.stringify(after.toast)}`)
  await shot(page, 'qa-39-legacy-purged')
  check(errors.length === 0, `legacy empty scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── workspace "+": new conversation directly inside a workspace ────────────
{
  const { page, errors } = await open('theme=light&wide=1')

  // nested workspace inside a project → the conversation joins that project
  const schoolwork = page.locator('.pj-group-nested').filter({ hasText: 'Schoolwork' }).first()
  await schoolwork.locator('.pj-group-header').hover()
  await schoolwork.locator('.pj-group-actions button').first().click()
  await page.waitForTimeout(900)
  const nested = await page.evaluate(() => {
    const sessions = window.__mocks.sessions.getSnapshot()
    const id = sessions.ids[sessions.ids.length - 1]
    const data = window.__mocks.projectData()
    const project = data.projects.find((entry) => entry.name === '课程作业')
    return { id, cwd: sessions.byId[id]?.cwd, assignment: data.assignments[id], projectId: project?.id }
  })
  console.log('workspace + (project):', JSON.stringify(nested))
  check(nested.cwd?.endsWith('/Schoolwork') === true, `nested workspace + should create in that directory: ${JSON.stringify(nested)}`)
  check(nested.assignment === nested.projectId, `nested workspace + should assign the conversation to its project: ${JSON.stringify(nested)}`)
  await shot(page, 'qa-40-workspace-plus-project')

  // workspace under Other conversations → ungrouped conversation in that directory
  const otherSoftware = page.locator('.pj-other-section .pj-group').filter({ hasText: 'Software' }).first()
  await otherSoftware.locator('.pj-group-header').hover()
  await otherSoftware.locator('.pj-group-actions button').first().click()
  await page.waitForTimeout(900)
  const other = await page.evaluate(() => {
    const sessions = window.__mocks.sessions.getSnapshot()
    const id = sessions.ids[sessions.ids.length - 1]
    const data = window.__mocks.projectData()
    return { id, cwd: sessions.byId[id]?.cwd, assignment: data.assignments[id] }
  })
  console.log('workspace + (other):', JSON.stringify(other))
  check(other.cwd?.endsWith('/Software') === true, `Other workspace + should create in that directory: ${JSON.stringify(other)}`)
  check(other.assignment === undefined || other.assignment === null, `Other workspace + should stay ungrouped: ${JSON.stringify(other)}`)
  await shot(page, 'qa-41-workspace-plus-other')
  check(errors.length === 0, `workspace + scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── dark menus/dialogs ─────────────────────────────────────────────────────
{
  const { page, errors } = await open('theme=dark&wide=1')
  const row = page.locator('.pj-session').nth(2)
  await row.hover()
  await row.locator('.pj-session-actions button').click()
  await page.waitForSelector('.pj-menu')
  await shot(page, 'qa-13-dark-session-menu')
  await page.keyboard.press('Escape')
  await page.locator('.pj-header-actions').locator('button').first().click()
  await page.waitForSelector('.pj-modal')
  await shot(page, 'qa-14-dark-new-project-dialog')
  await page.keyboard.press('Escape')
  check(errors.length === 0, `dark scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── minimal scenario: empty-state project creation via header ──────────────
{
  const { page, errors } = await open('scenario=minimal&theme=light&wide=1')
  check((await page.locator('.pj-section').count()) === 0, 'minimal scenario should start without projects')
  await page.locator('.pj-header-actions').locator('button').first().click()
  await page.waitForSelector('.pj-modal')
  await page.locator('.pj-modal input').first().fill('第一个项目')
  await page.locator('.pj-modal-footer button').last().click()
  await page.waitForTimeout(300)
  const names = await page.locator('.pj-section .pj-group-title').allInnerTexts()
  check(names.includes('第一个项目'), `minimal scenario project creation failed: ${JSON.stringify(names)}`)
  await shot(page, 'qa-15-minimal-project-created')
  check(errors.length === 0, `minimal scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

// ── rail: first rail button opens the new project dialog ───────────────────
{
  const { page, errors } = await open('theme=light&wide=0')
  const railButtons = await page.locator('.pj-rail-btn').count()
  check(railButtons >= 2, `rail should render two buttons (${railButtons})`)
  await shot(page, 'qa-16-rail')
  await page.locator('.pj-rail-btn').first().click()
  await page.waitForTimeout(300)
  check((await page.locator('.pj-modal').count()) === 1, 'rail new-project button should open the dialog')
  await shot(page, 'qa-17-rail-dialog')
  check(errors.length === 0, `rail scenario console errors: ${errors.join(' | ')}`)
  await page.close()
}

await browser.close()

if (failures.length > 0) {
  console.error('\nQA FAILURES:')
  for (const failure of failures) console.error(' -', failure)
  process.exitCode = 1
} else {
  console.log('\nall interaction checks passed')
}
