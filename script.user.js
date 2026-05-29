// ==UserScript==
// @name         超星学习通自动下一节
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  课程树导航 + 视频自动播放 + 自动跳转下一节，绕过"任务点未完成"弹窗
// @author       Claude (tree-nav from Codex)
// @match        https://*.chaoxing.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ---- 仅在顶层窗口运行 ----
    if (window !== window.top) {
        try { if (window.parent.document) return; } catch (e) {}
        // 跨域 iframe：简易自动播放
        setInterval(function () {
            var vs = document.querySelectorAll('video');
            for (var i = 0; i < vs.length; i++) {
                try {
                    vs[i].playbackRate = 2.0;
                    if (vs[i].paused) { vs[i].muted = true; vs[i].play().catch(function () {}); }
                } catch (e) {}
            }
        }, 2000);
        return;
    }

    // ---- 状态 ----
    var _videoEl = null;
    var _treeEl = null;
    var _isPlaying = false;
    var _checkTimer = null;
    var _lastUrl = location.href;
    var _popupHandled = false;

    var cellData = {
        cells: 0,
        nCells: 0,
        curChapter: 0,
        curSection: 0,
        curTitle: ''
    };

    // ---- 工具函数 ----
    function log(msg) { console.log('[超星助手] ' + msg); }

    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return (ctx || document).querySelectorAll(sel); }

    function _getTreeContainer() {
        if (!_treeEl) {
            _treeEl = document.getElementById('coursetree');
            if (!_treeEl) throw new Error('找不到课程树 #coursetree');
        }
        return _treeEl;
    }

    // ---- 课程树导航 ----
    function _initCellData() {
        var tree = _getTreeContainer();
        var chapters = tree.querySelectorAll(':scope > ul > li');
        cellData.cells = chapters.length;
        cellData.nCells = 0;
        var found = false;

        for (var i = 0; i < chapters.length; i++) {
            var sections = chapters[i].querySelectorAll('.posCatalog_select:not(.firstLayer)');
            cellData.nCells += sections.length;
            for (var j = 0; j < sections.length; j++) {
                if (sections[j].classList.contains('posCatalog_active')) {
                    cellData.curChapter = i;
                    cellData.curSection = j;
                    found = true;
                    var titleEl = sections[j].querySelector('.posCatalog_name');
                    if (titleEl) cellData.curTitle = titleEl.getAttribute('title') || titleEl.textContent || '';
                }
            }
        }
        if (!found && cellData.nCells > 0) {
            log('未找到当前激活节点，可能需手动定位');
        }
        log('课程: ' + cellData.cells + '章 ' + cellData.nCells + '节 | 当前: 第' + (cellData.curChapter + 1) + '章第' + (cellData.curSection + 1) + '节');
    }

    function _getCurrentSectionNode() {
        var tree = _getTreeContainer();
        var chapters = tree.querySelectorAll(':scope > ul > li');
        if (cellData.curChapter >= chapters.length) return null;
        var sections = chapters[cellData.curChapter].querySelectorAll('.posCatalog_select:not(.firstLayer)');
        if (cellData.curSection >= sections.length) return null;
        return sections[cellData.curSection];
    }

    function nextUnit() {
        log('=== 准备切换到下一小节 ===');
        var tree = _getTreeContainer();
        var chapters = tree.querySelectorAll(':scope > ul > li');
        var sections = chapters[cellData.curChapter]
            ? chapters[cellData.curChapter].querySelectorAll('.posCatalog_select:not(.firstLayer)')
            : [];

        // 同章还有下一节
        if (sections.length > cellData.curSection + 1) {
            cellData.curSection++;
            log('同章下一节: ' + (cellData.curSection + 1) + '/' + sections.length);
            _playCurrentIndex(sections[cellData.curSection]);
            return;
        }

        // 下一章
        var nextChapter = cellData.curChapter + 1;
        if (nextChapter >= chapters.length) {
            log('=== 本课程全部学习完成 ===');
            _clearCheckTimer();
            return;
        }
        cellData.curChapter = nextChapter;
        cellData.curSection = 0;
        log('下一章: ' + (cellData.curChapter + 1) + '/' + chapters.length);
        _playCurrentIndex();
    }

    function _playCurrentIndex(nCell) {
        if (!nCell) {
            var tree = _getTreeContainer();
            var chapters = tree.querySelectorAll(':scope > ul > li');
            if (cellData.curChapter >= chapters.length) { log('课程已完成'); return; }
            var sections = chapters[cellData.curChapter].querySelectorAll('.posCatalog_select:not(.firstLayer)');
            if (cellData.curSection >= sections.length) { log('章节已完成'); return; }
            nCell = sections[cellData.curSection];
        }

        var clickable = nCell.querySelector('.posCatalog_name');
        if (!clickable) { log('找不到可点击节点'); return; }

        log('点击切换: ' + (clickable.getAttribute('title') || clickable.textContent || '未知'));
        clickable.click();
        _videoEl = null;
        _isPlaying = false;

        // 等待页面加载新视频
        setTimeout(function () {
            _initCellData();
            play();
        }, 2500);
    }

    // ---- 视频定位 ----
    function _getVideoEl() {
        if (!_videoEl) {
            var all = _getAllVideoEls();
            _videoEl = all[0] || null;
        }
        return _videoEl;
    }

    function _getAllVideoEls() {
        var results = [];
        try {
            var iframe0 = $('iframe');
            if (!iframe0) return results;
            var innerDoc = iframe0.contentDocument || iframe0.contentWindow.document;
            if (!innerDoc) return results;
            var videoFrames = innerDoc.querySelectorAll('iframe.ans-insertvideo-online');
            for (var i = 0; i < videoFrames.length; i++) {
                try {
                    var vDoc = videoFrames[i].contentDocument || videoFrames[i].contentWindow.document;
                    if (vDoc) {
                        var v = vDoc.querySelector('video#video_html5_api');
                        if (v) results.push(v);
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return results;
    }

    function _isVideoCompleted(v) {
        // 视频已处于结束状态 = 已完成
        return v.ended || (v.duration > 0 && v.currentTime >= v.duration - 1);
    }

    // ---- 视频播放（支持多视频顺序播放） ----
    var _videoQueue = [];
    var _queueIndex = 0;

    function play() {
        _clearCheckTimer();

        // 首次获取所有视频
        _videoQueue = _getAllVideoEls();

        if (_videoQueue.length === 0) {
            log('未找到视频，尝试跳过当前小节...');
            _skipNonVideo();
            return;
        }

        log('当前小节共 ' + _videoQueue.length + ' 个视频');
        _playQueue(0);
    }

    function _playQueue(index) {
        if (index >= _videoQueue.length) {
            // 全部播完 → 下一节
            log('✔ 本小节所有视频已播放完毕');
            _isPlaying = false;
            setTimeout(function () { nextUnit(); }, 500);
            return;
        }

        var v = _videoQueue[index];
        _queueIndex = index;

        // 跳过已完成的视频
        if (_isVideoCompleted(v)) {
            log('⏭ 跳过已完成视频 (' + (index + 1) + '/' + _videoQueue.length + ')');
            _playQueue(index + 1);
            return;
        }

        _videoEl = v;
        _isPlaying = true;
        v.playbackRate = 2.0;

        // 绑定事件
        v.removeEventListener('ended', _onVideoEnded);
        v.addEventListener('ended', _onVideoEnded);

        var self = this;
        var promise = v.play();
        if (promise) {
            promise.then(function () {
                log('▶ 播放视频 (' + (index + 1) + '/' + _videoQueue.length + '): ' + (cellData.curTitle || '视频'));
                _startCheckTimer();
            }).catch(function () {
                log('播放失败，尝试静音...');
                v.muted = true;
                v.play().then(function () {
                    log('静音播放成功');
                    _startCheckTimer();
                }).catch(function () {
                    log('静音也失败，2秒后重试...');
                    setTimeout(function () { _playQueue(index); }, 2000);
                });
            });
        }
    }

    function _onVideoEnded() {
        if (!_isPlaying) return;
        _isPlaying = false;
        _clearCheckTimer();
        log('✔ 视频播放完毕 (' + (_queueIndex + 1) + '/' + _videoQueue.length + ')');
        // 播放下一个视频
        _playQueue(_queueIndex + 1);
    }

    // ---- 视频状态监控（保活 + 进度卡住检测） ----
    function _startCheckTimer() {
        _clearCheckTimer();
        var lastTime = 0;
        var lastWall = Date.now();
        _checkTimer = setInterval(function () {
            try {
                var el = _getVideoEl();
                if (!el || !_isPlaying) return;

                // 暂停恢复
                if (el.paused && !el.ended) {
                    log('检测到暂停，恢复播放...');
                    el.play().catch(function () {});
                    return;
                }

                // 进度卡住检测（7秒无进展）
                var cur = Number(el.currentTime || 0);
                if (Math.abs(cur - lastTime) < 0.05 && (Date.now() - lastWall) > 7000) {
                    log('进度卡住，尝试恢复...');
                    el.play().catch(function () {});
                    lastWall = Date.now();
                    lastTime = Number(el.currentTime || 0);
                } else if (Math.abs(cur - lastTime) >= 0.05) {
                    lastWall = Date.now();
                    lastTime = cur;
                }
            } catch (e) {}
        }, 2000);
    }

    function _clearCheckTimer() {
        if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
    }

    // ---- 非视频内容跳过（含全面翻阅） ----
    function _skipNonVideo() {
        // 1. 彻底翻阅页面内容
        _scrollAndComplete(document);

        // 2. 判断是不是章节测验
        try {
            var prevTitle = document.querySelector('.prev_title');
            if (prevTitle) {
                var title = prevTitle.title || prevTitle.textContent || '';
                if (/章节测验|测验|考试|作业/.test(title)) {
                    log('检测到章节测验，翻阅后跳过...');
                    _scrollAndComplete(document);
                    setTimeout(function () {
                        var btn = $('#prevNextFocusNext');
                        if (btn) btn.click();
                        setTimeout(function () { _initCellData(); _videoEl = null; play(); }, 2000);
                    }, 2000);
                    return;
                }
            }
        } catch (e) {}

        // 3. 尝试切换"视频"标签页（当前可能在"学习目标"等步骤页）
        var videoTabs = document.querySelectorAll('.prev_white');
        for (var t = 0; t < videoTabs.length; t++) {
            var tabText = (videoTabs[t].textContent || '').replace(/\s+/g, '');
            if (tabText.indexOf('视频') !== -1) {
                log('点击"视频"标签页...');
                videoTabs[t].click();
                _videoEl = null;
                setTimeout(function () { _initCellData(); play(); }, 2000);
                return;
            }
        }

        // 4. 文字/PPT/文档内容：翻阅到底后通过树导航走
        log('当前为文字/PPT/文档内容，翻阅完毕，通过树导航跳转...');
        nextUnit();
    }

    function _scrollAndComplete(doc) {
        if (!doc || !doc.body) return;
        try {
            // 滚动主文档到底部
            doc.documentElement.scrollTop = doc.documentElement.scrollHeight;
            doc.body.scrollTop = doc.body.scrollHeight;

            // 滚动所有内容容器
            var containers = doc.querySelectorAll(
                '.read_content, .article-content, .ans-attach-content, '
                + '.slidebox, .pptContainer, .slide-container, .ppt_page, '
                + '.main-content, #content, .course-content, .chapter-content, '
                + '[class*="content-area"], [class*="article"], [class*="read"], '
                + '.ans-attach, .attachment-content, .text-content, '
                + '.ebook-container, .reader-container, .document-container'
            );
            for (var i = 0; i < containers.length; i++) {
                try {
                    containers[i].scrollTop = containers[i].scrollHeight;
                    containers[i].scrollLeft = containers[i].scrollWidth;
                } catch (e) {}
            }

            // 模拟键盘翻页（部分PPT阅读器响应）
            try {
                doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', keyCode: 35, bubbles: true }));
                doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', keyCode: 34, bubbles: true }));
            } catch (e) {}

            // 点击 PPT 翻页按钮
            var pptBtns = doc.querySelectorAll(
                '.orientationRight, #rightArrow, .rightArrow, .next-slide, '
                + '.slide-next, .ppt-next, .next_page, .page-next, .nextPage, '
                + '.swiper-button-next, .carousel-next'
            );
            for (var k = 0; k < pptBtns.length; k++) {
                try { if (!pptBtns[k].disabled) pptBtns[k].click(); } catch (e) {}
            }

            // 递归处理 iframe
            var iframes = doc.querySelectorAll('iframe');
            for (var j = 0; j < iframes.length; j++) {
                try {
                    var inner = iframes[j].contentDocument || iframes[j].contentWindow.document;
                    if (inner) _scrollAndComplete(inner);
                } catch (e) {}
            }
        } catch (e) {}
        log('内容翻阅完成');
    }

    // ---- 弹窗拦截（精简版） ----
    function _installPopupGuard() {
        new MutationObserver(function (mutations) {
            if (_popupHandled) return;
            for (var i = 0; i < mutations.length; i++) {
                var nodes = mutations[i].addedNodes;
                for (var j = 0; j < nodes.length; j++) {
                    var node = nodes[j];
                    if (!node || !node.textContent) continue;
                    var text = node.textContent;

                    // 抢跑弹窗：任务点未完成 → 点"去学习"
                    if (/当前章节还/.test(text) || /任务点未完成/.test(text) || /尚未完成/.test(text)) {
                        _popupHandled = true;
                        log('⚠ 检测到抢跑弹窗，点击"去学习"...');
                        setTimeout(function () {
                            var btn = $('[onclick*="scroll2Job"]') || $('.btnBlue.popMoveDele');
                            if (btn) btn.click();
                            try { if (typeof scroll2Job === 'function') scroll2Job(); } catch (e) {}
                            _popupHandled = false;
                            // 重新尝试播放
                            setTimeout(function () { _initCellData(); play(); }, 1000);
                        }, 300);
                        return;
                    }

                    // 正常弹窗：点确定
                    if (/观看完毕|任务点完成|视频播放完毕|本节已学完|确定下一节|是否确定/.test(text)) {
                        _popupHandled = true;
                        log('检测到完成弹窗，点击确定...');
                        setTimeout(function () {
                            var btn = $('.layui-layer-btn0, .dialog-sure, .sure-btn, .btn_ok, .confirm');
                            if (btn) btn.click();
                            _popupHandled = false;
                        }, 300);
                        return;
                    }
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    // ---- URL 监控 ----
    function _watchUrl() {
        setInterval(function () {
            if (location.href !== _lastUrl) {
                _lastUrl = location.href;
                _videoEl = null;
                _isPlaying = false;
                _clearCheckTimer();
                log('检测到页面跳转，重新初始化...');
                setTimeout(function () { run(); }, 2000);
            }
        }, 2000);
    }

    // ---- 鼠标离开保持播放 ----
    function _preventPause() {
        var f = function (e) { e.stopPropagation(); e.preventDefault(); };
        document.addEventListener('mouseleave', f);
        document.addEventListener('mouseout', f);
        window.addEventListener('blur', function () {
            try { var el = _getVideoEl(); if (el && el.paused) el.play().catch(function () {}); } catch (e) {}
        });
    }

    // ---- 主入口 ----
    function run() {
        log('=== 超星助手 v3.0 启动 ===');
        log('URL: ' + location.href);

        _initCellData();
        _videoEl = null;
        _getVideoEl();
        play();
    }

    function init() {
        if (document.readyState === 'complete') {
            run();
            _installPopupGuard();
            _watchUrl();
            _preventPause();
        } else {
            window.addEventListener('load', function () {
                run();
                _installPopupGuard();
                _watchUrl();
                _preventPause();
            });
        }
    }

    init();
})();
