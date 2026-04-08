import streamlit as st
import pandas as pd
import numpy as np
import io
import csv

st.set_page_config(page_title="伝票照合ダッシュボード", layout="wide", page_icon="✨")

def format_date(date_str):
    if pd.isna(date_str) or date_str == '':
        return ''
    date_str = str(date_str).strip()
    cleaned = ''.join(filter(str.isdigit, date_str))
    if len(cleaned) == 8:
        return f"{cleaned[:4]}/{cleaned[4:6]}/{cleaned[6:8]}"
    if '-' in date_str:
        return date_str.replace('-', '/')
    return date_str

@st.cache_data
def parse_txt(file_content):
    data = []
    lines = file_content.decode('shift_jis', errors='replace').splitlines()
    for line in lines:
        if not line.strip(): continue
        row = line.split('\t')
        if len(row) < 136:
            continue
        date_raw = row[28]
        voucher_no_raw = row[38]
        qty_raw = row[127]
        unit_price_raw = row[135]
        
        if not voucher_no_raw or '伝票番号' in str(voucher_no_raw):
            continue
            
        voucher_no = str(voucher_no_raw).strip()
        voucher_no = voucher_no.lstrip('0')  # Remove zero padding
        if not voucher_no:
            continue
            
        try:
            qty = float(qty_raw) if str(qty_raw).strip() else 0.0
        except ValueError:
            qty = 0.0
        try:
            unit_price = float(unit_price_raw) if str(unit_price_raw).strip() else 0.0
        except ValueError:
            unit_price = 0.0
            
        amount = qty * unit_price
        date_val = format_date(date_raw)
        
        data.append({
            'voucherNo': voucher_no,
            'txtAmount': amount,
            'txtDate': date_val
        })
        
    df = pd.DataFrame(data)
    if not df.empty:
        df = df.groupby('voucherNo').agg({
            'txtAmount': 'sum',
            'txtDate': 'first'
        }).reset_index()
    else:
        df = pd.DataFrame(columns=['voucherNo', 'txtAmount', 'txtDate'])
    return df

@st.cache_data
def parse_csv(file_content):
    data = []
    content = file_content.decode('shift_jis', errors='replace')
    reader = csv.reader(io.StringIO(content))
    
    for row in reader:
        if not row: continue
        if len(row) < 16: continue
        
        date_raw = row[2]
        voucher_no_raw = row[9]
        amount_raw = row[15]
        
        if not voucher_no_raw or '伝票番号' in str(voucher_no_raw):
            continue
            
        voucher_no = str(voucher_no_raw).strip()
        voucher_no = voucher_no.lstrip('0')
        if not voucher_no:
            continue
            
        try:
            amount = float(amount_raw.replace(',', '')) if str(amount_raw).strip() else 0.0
        except ValueError:
            amount = 0.0
            
        date_val = format_date(date_raw)
        
        data.append({
            'voucherNo': voucher_no,
            'csvAmount': amount,
            'csvDate': date_val
        })
        
    df = pd.DataFrame(data)
    if not df.empty:
        df = df.groupby('voucherNo').agg({
            'csvAmount': 'sum',
            'csvDate': 'first'
        }).reset_index()
    else:
        df = pd.DataFrame(columns=['voucherNo', 'csvAmount', 'csvDate'])
    return df

def reconcile(df_txt, df_csv):
    if df_txt.empty and df_csv.empty:
        return pd.DataFrame()
        
    merged = pd.merge(df_txt, df_csv, on='voucherNo', how='outer')
    
    results = []
    for _, row in merged.iterrows():
        voucher_no = row['voucherNo']
        txt_amt = row['txtAmount']
        csv_amt = row['csvAmount']
        txt_date = row['txtDate']
        csv_date = row['csvDate']
        
        has_txt = pd.notna(txt_amt)
        has_csv = pd.notna(csv_amt)
        
        txt_amt = float(txt_amt) if has_txt else 0.0
        csv_amt = float(csv_amt) if has_csv else 0.0
        
        delivery_date = '-'
        if has_csv and pd.notna(csv_date) and csv_date != '':
            delivery_date = csv_date
        elif has_txt and pd.notna(txt_date) and txt_date != '':
            delivery_date = txt_date
            
        diff = txt_amt - csv_amt
        status = ''
        
        if has_txt and has_csv:
            tolerance = max(abs(csv_amt) * 0.001, 1.0)
            if abs(diff) <= tolerance:
                status = '✅ 一致'
            else:
                status = '❌ 不一致'
        elif has_txt:
            status = '📄 伝送(TXT)のみ'
        elif has_csv:
            status = '📈 計上(CSV)のみ'
            
        results.append({
            'ステータス': status,
            '納品年月日': delivery_date,
            '伝票番号': voucher_no,
            '伝送額(TXT)': txt_amt if has_txt else None,
            '計上額(CSV)': csv_amt if has_csv else None,
            '差額': diff,
            '_status_code': 'MATCH' if '一致' in status and '不' not in status else 
                            'MISMATCH' if '不一致' in status else 
                            'ONLY_TXT' if 'TXT' in status else 'ONLY_CSV'
        })
        
    df_res = pd.DataFrame(results)
    
    if not df_res.empty:
        df_res['sort_date'] = df_res['納品年月日'].replace('-', '9999/99/99')
        df_res['is_match'] = df_res['_status_code'] == 'MATCH'
        df_res['abs_diff'] = df_res['差額'].abs()
        
        df_res = df_res.sort_values(
            by=['sort_date', 'is_match', 'abs_diff'], 
            ascending=[True, True, False]
        )
        df_res = df_res.drop(columns=['sort_date', 'is_match', 'abs_diff'])
        
    return df_res

# --- Dashboard UI ---
st.title("✨ ジョイフル本田 納品データ照合アプリ")
st.markdown("""
オラクルクラウドの「**納品確定データ(.txt)**」と、新見れるクンの「**ジョイフル納品確定チェック(.csv)**」をアップロードするだけで、伝票ごとの金額差異を瞬時に自動チェックします！🔍
計算時の小数点の切り上げ・切り捨てによる**0.1%の端数誤差は自動で許容**されるので、本当に確認が必要なズレだけを一目で発見できます💡
""")

col1, col2 = st.columns(2)

with col1:
    st.subheader("📄 計上データ (CSV)")
    st.caption("J列: 納品伝票番号 / P列: 売上金額 (※新見れるクン)")
    csv_file = st.file_uploader("CSVファイルを選択してください", type=['csv'])

with col2:
    st.subheader("📄 伝送データ (TXT)")
    st.caption("AM列: 伝票番号 / DX列×EF列: 原価金額 (※オラクルクラウド)")
    txt_file = st.file_uploader("TXTファイルを選択してください", type=['txt', 'csv'])

if csv_file and txt_file:
    with st.spinner("照合を実行中..."):
        df_csv = parse_csv(csv_file.getvalue())
        df_txt = parse_txt(txt_file.getvalue())
        
        df_results = reconcile(df_txt, df_csv)
    
    if not df_results.empty:
        # Metics
        total = len(df_results)
        match_c = len(df_results[df_results['_status_code'] == 'MATCH'])
        mismatch_c = len(df_results[df_results['_status_code'] == 'MISMATCH'])
        only_txt_c = len(df_results[df_results['_status_code'] == 'ONLY_TXT'])
        only_csv_c = len(df_results[df_results['_status_code'] == 'ONLY_CSV'])
        
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("総伝票数", total)
        m2.metric("✅ 一致", match_c)
        m3.metric("❌ 金額不一致", mismatch_c)
        m4.metric("⚠️ 片方のみ存在", only_txt_c + only_csv_c)
        
        st.divider()
        
        filter_status = st.radio("フィルタ", 
                                 ["すべて", "不一致のみ", "片方のみ存在"], 
                                 horizontal=True)
        
        df_display = df_results.copy()
        if filter_status == "不一致のみ":
            df_display = df_display[df_display['_status_code'] == 'MISMATCH']
        elif filter_status == "片方のみ存在":
            df_display = df_display[df_display['_status_code'].isin(['ONLY_TXT', 'ONLY_CSV'])]
            
        # Drop internal column for display
        df_display = df_display.drop(columns=['_status_code'])
        
        def highlight_diff(val):
            if pd.isna(val):
                return ''
            if val > 0:
                return 'color: #d32f2f'
            elif val < 0:
                return 'color: #d32f2f'
            return 'color: #388e3c'
            
        def highlight_status(val):
            if '一致' in str(val) and '不' not in str(val):
                return 'background-color: #e8f5e9; color: #2e7d32'
            elif '不一致' in str(val):
                return 'background-color: #ffebee; color: #c62828'
            else:
                return 'background-color: #fff8e1; color: #f57f17'
                
        # Format styling
        styled_df = df_display.style.map(highlight_status, subset=['ステータス']) \
                                    .map(highlight_diff, subset=['差額']) \
                                    .format({
                                        '伝送額(TXT)': "¥{:,.0f}",
                                        '計上額(CSV)': "¥{:,.0f}",
                                        '差額': "¥{:,.0f}"
                                    }, na_rep="-")
                                    
        st.dataframe(styled_df, use_container_width=True, hide_index=True)

else:
    st.info("👆 上部のパネルからファイルを2つ選択してください。自動的に照合が開始されます。")
